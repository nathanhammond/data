
var Reference = function(type, id, store, container, data) {
  this.type = type;
  this.id = id;
  this.store = store;
  this.container = container;
  this._data = data;
};

Reference.prototype = {
  constructor: Reference,
  getRecord: function() {
    if (!this.record) {
      // lookupFactory should really return an object that creates
      // instances with the injections applied
      this.record = this.type._create({
        id: this.id,
        store: this.store,
        container: this.container
      });
    }
    return this.record;
  },

  unloadRecord: function() {
    return this.record.unloadRecord();
  },

  destroy: function() {
    return this.record.destroy();
  }

};

export default Reference;
