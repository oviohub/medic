const infodoc = require('../services/infodoc');

module.exports = {
  mark: (req, res, next) => {
    req.triggerInfoDocUpdate = true;
    next();
  },
  update: (proxyRes, req) => {
    if (req.triggerInfoDocUpdate) {
      let body = Buffer.from('');
      proxyRes.on('data', data => (body = Buffer.concat([body, data])));
      proxyRes.on('end', () => {
        body = JSON.parse(body.toString());
        if (body.ok && body.id) {
          infodoc.updateOne(body.id);
        } else if (Array.isArray(body)) {
          const successfulWrites = body.filter(r => r.ok).map(r => r.id);
          if (successfulWrites.length > 0) {
            infodoc.updateMany(successfulWrites);
          }
        }
      });
    }
  }
};
