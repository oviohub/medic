const db = require('../db');
const infodoc = require('@medic/infodoc');
infodoc.initLib(db.medic, db.sentinel);

module.exports = {
  mark: type => (req, res, next) => {
    if (type === 'single' && !req.body._deleted) {
      req.triggerInfoDocUpdate = true;
    } else if (type === 'bulk') {
      // Array of indexes of writes that aren't deletes. We'll use this below in update
      req.triggerInfoDocUpdate = req.body.docs
        .map(({_deleted}, idx) => ({_deleted, idx}))
        .filter(r => !r._deleted)
        .map(({idx}) => idx);
    }

    next();
  },
  update: (proxyRes, req) => {
    if (req.triggerInfoDocUpdate) {
      let body = Buffer.from('');
      proxyRes.on('data', data => (body = Buffer.concat([body, data])));
      proxyRes.on('end', () => {
        body = JSON.parse(body.toString());
        if (body.ok && body.id) {
          infodoc.recordDocumentWrite(body.id);
        } else if (Array.isArray(body)) {
          // A write that worked and wasn't a delete
          const successfulWrites = req.triggerInfoDocUpdate
            .map(idx => body[idx])
            .filter(r => r.ok)
            .map(r => r.id);

          if (successfulWrites.length > 0) {
            infodoc.recordDocumentWrites(successfulWrites);
          }
        }
      });
    }
  }
};
