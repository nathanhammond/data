import merge from "ember-data/system/merge";

var get = Ember.get;
var set = Ember.set;
var forEach = Ember.ArrayPolyfills.forEach;
var map = Ember.ArrayPolyfills.map;

var Reference = function(type, id, store, container, data) {
  this.type = type;
  this.id = id;
  this.store = store;
  this.container = container;
  this._setup();
  this._data = data || {};
  this.isEmpty = true;
  this.typeKey = type.typeKey;
};

Reference.prototype = {
  constructor: Reference,
  materializeRecord: function() {
    // lookupFactory should really return an object that creates
    // instances with the injections applied
    this.record = this.type._create({
      id: this.id,
      store: this.store,
      container: this.container,
      reference: this
    });
    this.isEmpty = false;
  },

  _setup: function() {
    this._deferredTriggers = [];
    this._data = {};
    this._attributes = Ember.create(null);
    this._inFlightAttributes = Ember.create(null);
    this._relationships = {};
    /*
      implicit relationships are relationship which have not been declared but the inverse side exists on
      another record somewhere
      For example if there was
      ```
        App.Comment = DS.Model.extend({
          name: DS.attr()
        })
      ```
      but there is also
      ```
        App.Post = DS.Model.extend({
          name: DS.attr(),
          comments: DS.hasMany('comment')
        })
      ```

      would have a implicit post relationship in order to be do things like remove ourselves from the post
      when we are deleted
    */
    this._implicitRelationships = Ember.create(null);
    //var model = this;
    //TODO Move into a getter for better perf
    /*
    this.constructor.eachRelationship(function(key, descriptor) {
      model._relationships[key] = createRelationshipFor(model, descriptor, model.store);
    });
    */
  },

  getRecord: function() {
    if (!this.record) {
      this.materializeRecord();
    }
    return this.record;
  },

  unloadRecord: function() {
    return this.record.unloadRecord();
  },

  setupData: function(data) {
    //var changedKeys = mergeAndReturnChangedKeys(this._data, data);
    mergeAndReturnChangedKeys(this._data, data);
  },

  destroy: function() {
    return this.record.destroy();
  },

  /**
    @method clearRelationships
    @private
  */
  clearRelationships: function() {
    this.eachRelationship(function(name, relationship) {
      var rel = this._relationships[name];
      if (rel) {
        //TODO(Igor) figure out whether we want to clear or disconnect
        rel.clear();
        rel.destroy();
      }
    }, this);
    var model = this;
    forEach.call(Ember.keys(this._implicitRelationships), function(key) {
      model._implicitRelationships[key].clear();
      model._implicitRelationships[key].destroy();
    });
  },

  disconnectRelationships: function() {
    this.eachRelationship(function(name, relationship) {
      this._relationships[name].disconnect();
    }, this);
    var model = this;
    forEach.call(Ember.keys(this._implicitRelationships), function(key) {
      model._implicitRelationships[key].disconnect();
    });
  },

  reconnectRelationships: function() {
    this.eachRelationship(function(name, relationship) {
      this._relationships[name].reconnect();
    }, this);
    var model = this;
    forEach.call(Ember.keys(this._implicitRelationships), function(key) {
      model._implicitRelationships[key].reconnect();
    });
  },


  /**
    When a find request is triggered on the store, the user can optionally pass in
    attributes and relationships to be preloaded. These are meant to behave as if they
    came back from the server, except the user obtained them out of band and is informing
    the store of their existence. The most common use case is for supporting client side
    nested URLs, such as `/posts/1/comments/2` so the user can do
    `store.find('comment', 2, {post:1})` without having to fetch the post.

    Preloaded data can be attributes and relationships passed in either as IDs or as actual
    models.

    @method _preloadData
    @private
    @param {Object} preload
  */
  _preloadData: function(preload) {
    var record = this;
    //TODO(Igor) consider the polymorphic case
    forEach.call(Ember.keys(preload), function(key) {
      var preloadValue = get(preload, key);
      var relationshipMeta = record.constructor.metaForProperty(key);
      if (relationshipMeta.isRelationship) {
        record._preloadRelationship(key, preloadValue);
      } else {
        get(record, '_data')[key] = preloadValue;
      }
    });
  },

  _preloadRelationship: function(key, preloadValue) {
    var relationshipMeta = this.constructor.metaForProperty(key);
    var type = relationshipMeta.type;
    if (relationshipMeta.kind === 'hasMany') {
      this._preloadHasMany(key, preloadValue, type);
    } else {
      this._preloadBelongsTo(key, preloadValue, type);
    }
  },

  _preloadHasMany: function(key, preloadValue, type) {
    Ember.assert("You need to pass in an array to set a hasMany property on a record", Ember.isArray(preloadValue));
    var record = this;

    var recordsToSet = map.call(preloadValue, function(recordToPush) {
      return record._convertStringOrNumberIntoRecord(recordToPush, type);
    });
    //We use the pathway of setting the hasMany as if it came from the adapter
    //because the user told us that they know this relationships exists already
    this._relationships[key].updateRecordsFromAdapter(recordsToSet);
  },

  _preloadBelongsTo: function(key, preloadValue, type) {
    var recordToSet = this._convertStringOrNumberIntoRecord(preloadValue, type);

    //We use the pathway of setting the hasMany as if it came from the adapter
    //because the user told us that they know this relationships exists already
    this._relationships[key].setRecord(recordToSet);
  },

  _convertStringOrNumberIntoRecord: function(value, type) {
    if (Ember.typeOf(value) === 'string' || Ember.typeOf(value) === 'number') {
      return this.store.recordForId(type, value);
    }
    return value;
  },


  /**
    @method updateRecordArrays
    @private
  */
  updateRecordArrays: function() {
    this._updatingRecordArraysLater = false;
    this.store.dataWasUpdated(this.constructor, this);
  },

  /**
    If the adapter did not return a hash in response to a commit,
    merge the changed attributes and relationships into the existing
    saved data.

    @method adapterDidCommit
  */
  adapterDidCommit: function(data) {
    var changedKeys;
    set(this, 'isError', false);

    if (data) {
      changedKeys = mergeAndReturnChangedKeys(this._data, data);
    } else {
      merge(this._data, this._inFlightAttributes);
    }

    this._inFlightAttributes = Ember.create(null);

    this.send('didCommit');
    this.updateRecordArraysLater();

    if (!data) { return; }

    this._notifyProperties(changedKeys);
  },

  /**
    @method updateRecordArraysLater
    @private
  */
  updateRecordArraysLater: function() {
    // quick hack (something like this could be pushed into run.once
    if (this._updatingRecordArraysLater) { return; }
    this._updatingRecordArraysLater = true;

    Ember.run.schedule('actions', this, this.updateRecordArrays);
  },
  // FOR USE DURING COMMIT PROCESS

  /**
    @method adapterDidInvalidate
    @private
  */
  adapterDidInvalidate: function(errors) {
    var recordErrors = get(this, 'errors');
    for (var key in errors) {
      if (!errors.hasOwnProperty(key)) {
        continue;
      }
      recordErrors.add(key, errors[key]);
    }
    this._saveWasRejected();
  },

  /**
    @method adapterDidError
    @private
  */
  adapterDidError: function() {
    this.send('becameError');
    set(this, 'isError', true);
    this._saveWasRejected();
  },

  _saveWasRejected: function() {
    var keys = Ember.keys(this._inFlightAttributes);
    for (var i=0; i < keys.length; i++) {
      if (this._attributes[keys[i]] === undefined) {
        this._attributes[keys[i]] = this._inFlightAttributes[keys[i]];
      }
    }
    this._inFlightAttributes = Ember.create(null);
  },
};

// Like Ember.merge, but instead returns a list of keys
// for values that fail a strict equality check
// instead of the original object.
function mergeAndReturnChangedKeys(original, updates) {
  var changedKeys = [];

  if (!updates || typeof updates !== 'object') {
    return changedKeys;
  }

  var keys   = Ember.keys(updates);
  var length = keys.length;
  var i, val, key;

  for (i = 0; i < length; i++) {
    key = keys[i];
    val = updates[key];

    if (original[key] !== val) {
      changedKeys.push(key);
    }

    original[key] = val;
  }
  return changedKeys;
}

export default Reference;
