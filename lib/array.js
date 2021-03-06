'use strict';

// Load modules

const Any = require('./any');
const Cast = require('./cast');
const Errors = require('./errors');
const Hoek = require('hoek');


// Declare internals

const internals = {};


internals.fastSplice = function (arr, i) {

    let pos = i;
    while (pos < arr.length) {
        arr[pos++] = arr[pos];
    }

    --arr.length;
};


internals.Array = function () {

    Any.call(this);
    this._type = 'array';
    this._inner.items = [];
    this._inner.ordereds = [];
    this._inner.inclusions = [];
    this._inner.exclusions = [];
    this._inner.requireds = [];
    this._flags.sparse = false;
};

Hoek.inherits(internals.Array, Any);


internals.Array.prototype._base = function (value, state, options) {

    const result = {
        value: value
    };

    if (typeof value === 'string' &&
        options.convert) {

        try {
            const converted = JSON.parse(value);
            if (Array.isArray(converted)) {
                result.value = converted;
            }
        }
        catch (e) { }
    }

    let isArray = Array.isArray(result.value);
    const wasArray = isArray;
    if (options.convert && this._flags.single && !isArray) {
        result.value = [result.value];
        isArray = true;
    }

    if (!isArray) {
        result.errors = Errors.create('array.base', null, state, options);
        return result;
    }

    if (this._inner.inclusions.length ||
        this._inner.exclusions.length ||
        !this._flags.sparse) {

        // Clone the array so that we don't modify the original
        if (wasArray) {
            result.value = result.value.slice(0);
        }

        result.errors = internals.checkItems.call(this, result.value, wasArray, state, options);

        if (result.errors && wasArray && options.convert && this._flags.single) {

            // Attempt a 2nd pass by putting the array inside one.
            const previousErrors = result.errors;

            result.value = [result.value];
            result.errors = internals.checkItems.call(this, result.value, wasArray, state, options);

            if (result.errors) {

                // Restore previous errors and value since this didn't validate either.
                result.errors = previousErrors;
                result.value = result.value[0];
            }
        }
    }

    return result;
};


internals.checkItems = function (items, wasArray, state, options) {

    const errors = [];
    let errored;

    const requireds = this._inner.requireds.slice();
    const ordereds = this._inner.ordereds.slice();
    const inclusions = this._inner.inclusions.concat(requireds);

    let il = items.length;
    for (let i = 0; i < il; ++i) {
        errored = false;
        const item = items[i];
        let isValid = false;
        const localState = { key: i, path: (state.path ? state.path + '.' : '') + i, parent: items, reference: state.reference };
        let res;

        // Sparse

        if (!this._flags.sparse && item === undefined) {
            errors.push(Errors.create('array.sparse', null, { key: state.key, path: localState.path }, options));

            if (options.abortEarly) {
                return errors;
            }

            continue;
        }

        // Exclusions

        for (let j = 0; j < this._inner.exclusions.length; ++j) {
            res = this._inner.exclusions[j]._validate(item, localState, {});                // Not passing options to use defaults

            if (!res.errors) {
                errors.push(Errors.create(wasArray ? 'array.excludes' : 'array.excludesSingle', { pos: i, value: item }, { key: state.key, path: localState.path }, options));
                errored = true;

                if (options.abortEarly) {
                    return errors;
                }

                break;
            }
        }

        if (errored) {
            continue;
        }

        // Ordered
        if (this._inner.ordereds.length) {
            if (ordereds.length > 0) {
                const ordered = ordereds.shift();
                res = ordered._validate(item, localState, options);
                if (!res.errors) {
                    if (ordered._flags.strip) {
                        internals.fastSplice(items, i);
                        --i;
                        --il;
                    }
                    else {
                        items[i] = res.value;
                    }
                }
                else {
                    errors.push(Errors.create('array.ordered', { pos: i, reason: res.errors, value: item }, { key: state.key, path: localState.path }, options));
                    if (options.abortEarly) {
                        return errors;
                    }
                }
                continue;
            }
            else if (!this._inner.items.length) {
                errors.push(Errors.create('array.orderedLength', { pos: i, limit: this._inner.ordereds.length }, { key: state.key, path: localState.path }, options));
                if (options.abortEarly) {
                    return errors;
                }
                continue;
            }
        }

        // Requireds

        const requiredChecks = [];
        let jl = requireds.length;
        for (let j = 0; j < jl; ++j) {
            res = requiredChecks[j] = requireds[j]._validate(item, localState, options);
            if (!res.errors) {
                items[i] = res.value;
                isValid = true;
                internals.fastSplice(requireds, j);
                --j;
                --jl;
                break;
            }
        }

        if (isValid) {
            continue;
        }

        // Inclusions

        jl = inclusions.length;
        for (let j = 0; j < jl; ++j) {
            const inclusion = inclusions[j];

            // Avoid re-running requireds that already didn't match in the previous loop
            const previousCheck = requireds.indexOf(inclusion);
            if (previousCheck !== -1) {
                res = requiredChecks[previousCheck];
            }
            else {
                res = inclusion._validate(item, localState, options);

                if (!res.errors) {
                    if (inclusion._flags.strip) {
                        internals.fastSplice(items, i);
                        --i;
                        --il;
                    }
                    else {
                        items[i] = res.value;
                    }
                    isValid = true;
                    break;
                }
            }

            // Return the actual error if only one inclusion defined
            if (jl === 1) {
                if (options.stripUnknown) {
                    internals.fastSplice(items, i);
                    --i;
                    --il;
                    isValid = true;
                    break;
                }

                errors.push(Errors.create(wasArray ? 'array.includesOne' : 'array.includesOneSingle', { pos: i, reason: res.errors, value: item }, { key: state.key, path: localState.path }, options));
                errored = true;

                if (options.abortEarly) {
                    return errors;
                }

                break;
            }
        }

        if (errored) {
            continue;
        }

        if (this._inner.inclusions.length && !isValid) {
            if (options.stripUnknown) {
                internals.fastSplice(items, i);
                --i;
                --il;
                continue;
            }

            errors.push(Errors.create(wasArray ? 'array.includes' : 'array.includesSingle', { pos: i, value: item }, { key: state.key, path: localState.path }, options));

            if (options.abortEarly) {
                return errors;
            }
        }
    }

    if (requireds.length) {
        internals.fillMissedErrors(errors, requireds, state, options);
    }

    if (ordereds.length) {
        internals.fillOrderedErrors(errors, ordereds, state, options);
    }

    return errors.length ? errors : null;
};


internals.fillMissedErrors = function (errors, requireds, state, options) {

    const knownMisses = [];
    let unknownMisses = 0;
    for (let i = 0; i < requireds.length; ++i) {
        const label = Hoek.reach(requireds[i], '_settings.language.label');
        if (label) {
            knownMisses.push(label);
        }
        else {
            ++unknownMisses;
        }
    }

    if (knownMisses.length) {
        if (unknownMisses) {
            errors.push(Errors.create('array.includesRequiredBoth', { knownMisses: knownMisses, unknownMisses: unknownMisses }, { key: state.key, path: state.patk }, options));
        }
        else {
            errors.push(Errors.create('array.includesRequiredKnowns', { knownMisses: knownMisses }, { key: state.key, path: state.path }, options));
        }
    }
    else {
        errors.push(Errors.create('array.includesRequiredUnknowns', { unknownMisses: unknownMisses }, { key: state.key, path: state.path }, options));
    }
};


internals.fillOrderedErrors = function (errors, ordereds, state, options) {

    const requiredOrdereds = [];

    for (let i = 0; i < ordereds.length; ++i) {
        const presence = Hoek.reach(ordereds[i], '_flags.presence');
        if (presence === 'required') {
            requiredOrdereds.push(ordereds[i]);
        }
    }

    if (requiredOrdereds.length) {
        internals.fillMissedErrors(errors, requiredOrdereds, state, options);
    }
};

internals.Array.prototype.describe = function () {

    const description = Any.prototype.describe.call(this);

    if (this._inner.ordereds.length) {
        description.orderedItems = [];

        for (let i = 0; i < this._inner.ordereds.length; ++i) {
            description.orderedItems.push(this._inner.ordereds[i].describe());
        }
    }

    if (this._inner.items.length) {
        description.items = [];

        for (let i = 0; i < this._inner.items.length; ++i) {
            description.items.push(this._inner.items[i].describe());
        }
    }

    return description;
};


internals.Array.prototype.items = function () {

    const obj = this.clone();

    Hoek.flatten(Array.prototype.slice.call(arguments)).forEach((type, index) => {

        try {
            type = Cast.schema(type);
        }
        catch (castErr) {
            if (castErr.hasOwnProperty('path')) {
                castErr.path = index + '.' + castErr.path;
            }
            else {
                castErr.path = index;
            }
            castErr.message = castErr.message + '(' + castErr.path + ')';
            throw castErr;
        }

        obj._inner.items.push(type);

        if (type._flags.presence === 'required') {
            obj._inner.requireds.push(type);
        }
        else if (type._flags.presence === 'forbidden') {
            obj._inner.exclusions.push(type.optional());
        }
        else {
            obj._inner.inclusions.push(type);
        }
    });

    return obj;
};


internals.Array.prototype.ordered = function () {

    const obj = this.clone();

    Hoek.flatten(Array.prototype.slice.call(arguments)).forEach((type, index) => {

        try {
            type = Cast.schema(type);
        }
        catch (castErr) {
            if (castErr.hasOwnProperty('path')) {
                castErr.path = index + '.' + castErr.path;
            }
            else {
                castErr.path = index;
            }
            castErr.message = castErr.message + '(' + castErr.path + ')';
            throw castErr;
        }
        obj._inner.ordereds.push(type);
    });

    return obj;
};


internals.Array.prototype.min = function (limit) {

    Hoek.assert(Hoek.isInteger(limit) && limit >= 0, 'limit must be a positive integer');

    return this._test('min', limit, (value, state, options) => {

        if (value.length >= limit) {
            return null;
        }

        return Errors.create('array.min', { limit: limit, value: value }, state, options);
    });
};


internals.Array.prototype.max = function (limit) {

    Hoek.assert(Hoek.isInteger(limit) && limit >= 0, 'limit must be a positive integer');

    return this._test('max', limit, (value, state, options) => {

        if (value.length <= limit) {
            return null;
        }

        return Errors.create('array.max', { limit: limit, value: value }, state, options);
    });
};


internals.Array.prototype.length = function (limit) {

    Hoek.assert(Hoek.isInteger(limit) && limit >= 0, 'limit must be a positive integer');

    return this._test('length', limit, (value, state, options) => {

        if (value.length === limit) {
            return null;
        }

        return Errors.create('array.length', { limit: limit, value: value }, state, options);
    });
};


internals.Array.prototype.unique = function () {

    return this._test('unique', undefined, (value, state, options) => {

        const found = {
            string: {},
            number: {},
            undefined: {},
            boolean: {},
            object: [],
            function: []
        };

        for (let i = 0; i < value.length; ++i) {
            const item = value[i];
            const type = typeof item;
            const records = found[type];

            // All available types are supported, so it's not possible to reach 100% coverage without ignoring this line.
            // I still want to keep the test for future js versions with new types (eg. Symbol).
            if (/* $lab:coverage:off$ */ records /* $lab:coverage:on$ */) {
                if (Array.isArray(records)) {
                    for (let j = 0; j < records.length; ++j) {
                        if (Hoek.deepEqual(records[j], item)) {
                            return Errors.create('array.unique', { pos: i, value: item }, state, options);
                        }
                    }

                    records.push(item);
                }
                else {
                    if (records[item]) {
                        return Errors.create('array.unique', { pos: i, value: item }, state, options);
                    }

                    records[item] = true;
                }
            }
        }
    });
};


internals.Array.prototype.sparse = function (enabled) {

    const obj = this.clone();
    obj._flags.sparse = enabled === undefined ? true : !!enabled;
    return obj;
};


internals.Array.prototype.single = function (enabled) {

    const obj = this.clone();
    obj._flags.single = enabled === undefined ? true : !!enabled;
    return obj;
};


module.exports = new internals.Array();
