'use strict';

function parseId(value) {
  var text = String(value == null ? '' : value).trim();
  if (!/^\d+$/.test(text)) return 0;
  var id = Number(text);
  return Number.isSafeInteger(id) && id > 0 && id <= 2147483647 ? id : 0;
}

function addAttributes(target, tag, names) {
  names.forEach(function(name) {
    var re = new RegExp('\\b' + name + '\\s*=\\s*(["\\\'])(\\d+)\\1', 'i');
    var match = String(tag || '').match(re);
    var id = match ? parseId(match[2]) : 0;
    if (id) target.add(id);
  });
}

// Only record ids that represent actual pet/skin identities. A broad scan for
// every ID attribute also captures <Move ID>, effect ids, and other unrelated
// values, which makes an unused manual target look officially occupied.
function collectOfficialIdentityIdsFromXml(input) {
  var text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input || '');
  var result = new Set();
  var tagRe = /<(Monster|pet|fighter)\b[^>]*>/gi;
  var match;
  while ((match = tagRe.exec(text)) !== null) {
    var name = String(match[1] || '').toLowerCase();
    if (name === 'monster') addAttributes(result, match[0], ['ID', 'NumbersID']);
    else if (name === 'pet') addAttributes(result, match[0], ['resourceId', 'skinId']);
    else addAttributes(result, match[0], ['id']);
  }
  return result;
}

module.exports = { collectOfficialIdentityIdsFromXml };
