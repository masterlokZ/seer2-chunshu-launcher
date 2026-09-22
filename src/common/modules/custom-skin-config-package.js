'use strict';

function createCustomSkinConfigPackage(deps) {
  const fs = deps.fs;
  const path = deps.path;
  const parseId = deps.parseId;
  const fileTypes = Array.isArray(deps.fileTypes) ? deps.fileTypes.slice() : [];
  const managedRoot = deps.managedRoot;

  function currentManagedRoot() {
    const value = typeof managedRoot === 'function' ? managedRoot() : managedRoot;
    return String(value || '').trim();
  }

  function keyOf(value) {
    const resolved = path.resolve(String(value || ''));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }

  async function usableSwf(candidate) {
    const value = String(candidate || '').trim();
    if (!value || !path.isAbsolute(value) || !/\.swf$/i.test(value)) return '';
    try {
      const stat = await fs.promises.stat(value);
      return stat.isFile() && stat.size > 0 ? path.resolve(value) : '';
    } catch (_) {
      return '';
    }
  }

  async function resolveFile(entry, type, configDir, exportRoot) {
    const files = entry && entry.files && typeof entry.files === 'object' ? entry.files : {};
    const absoluteFiles = entry && entry.absoluteFiles && typeof entry.absoluteFiles === 'object'
      ? entry.absoluteFiles : {};
    const resourceFiles = entry && entry.resourceFiles && typeof entry.resourceFiles === 'object'
      ? entry.resourceFiles : {};
    const raw = String(files[type] || '').trim();
    const absolute = String(absoluteFiles[type] || resourceFiles[type] && resourceFiles[type].absolute || '').trim();
    const candidates = [];
    if (absolute) candidates.push(absolute);
    if (raw) {
      if (/^https?:\/\//i.test(raw)) {
        throw new Error('配置不接受远程 URL：' + raw);
      }
      if (path.isAbsolute(raw)) candidates.push(raw);
      else {
        candidates.push(path.resolve(configDir, raw));
        if (exportRoot) candidates.push(path.resolve(exportRoot, raw));
        const root = currentManagedRoot();
        if (root) candidates.push(path.resolve(root, raw.replace(/^\.[\\/]/, '')));
      }
    }
    const seen = new Set();
    for (let index = 0; index < candidates.length; index++) {
      const candidate = path.resolve(candidates[index]);
      const key = keyOf(candidate);
      if (seen.has(key)) continue;
      seen.add(key);
      const found = await usableSwf(candidate);
      if (found) return found;
    }
    return '';
  }

  async function read(configFile) {
    const file = path.resolve(String(configFile || ''));
    let stat;
    try { stat = await fs.promises.stat(file); }
    catch (_) { throw new Error('皮肤配置不存在：' + file); }
    if (!stat.isFile() || stat.size <= 0 || stat.size > 8 * 1024 * 1024) {
      throw new Error('皮肤配置大小无效：' + file);
    }
    let raw;
    try { raw = JSON.parse(await fs.promises.readFile(file, 'utf8')); }
    catch (error) { throw new Error('皮肤配置无法解析：' + error.message); }
    const skins = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.skins) ? raw.skins : null);
    if (!skins || !skins.length) throw new Error('皮肤配置中没有可用 skins 数组');
    const version = Array.isArray(raw) ? 1 : (parseInt(raw.version, 10) || 0);
    if (version && version !== 1 && version !== 2 && version !== 3) {
      throw new Error('不支持的皮肤配置版本：' + version);
    }
    const configDir = path.dirname(file);
    const exportRoot = raw && raw.exportRoot && path.isAbsolute(String(raw.exportRoot))
      ? path.resolve(String(raw.exportRoot)) : '';
    const sources = [];
    const sourceKeys = new Set();
    const bindingsBySource = {};
    const missing = [];
    const claimedSkinIds = new Set();
    for (let entryIndex = 0; entryIndex < skins.length; entryIndex++) {
      const input = skins[entryIndex] || {};
      const skinId = parseId(input.skinId);
      const sourceId = parseId(input.sourceId);
      if (!skinId || !sourceId) {
        throw new Error('配置第 ' + (entryIndex + 1) + ' 项缺少有效 skinId/sourceId');
      }
      if (claimedSkinIds.has(skinId)) throw new Error('配置中重复使用 skinId：' + skinId);
      claimedSkinIds.add(skinId);
      const entry = Object.assign({}, input, {
        skinId:skinId,
        sourceId:sourceId,
        name:String(input.name || '').trim().slice(0, 80),
        files:Object.assign({}, input.files || {}),
      });
      const groupKey = 'config:' + entryIndex + ':' + String(entry.id || skinId);
      let resolvedCount = 0;
      for (let typeIndex = 0; typeIndex < fileTypes.length; typeIndex++) {
        const type = fileTypes[typeIndex];
        const declared = String(entry.files[type] || entry.absoluteFiles && entry.absoluteFiles[type] ||
          entry.resourceFiles && entry.resourceFiles[type] && entry.resourceFiles[type].absolute || '').trim();
        if (!declared) continue;
        const resolved = await resolveFile(entry, type, configDir, exportRoot);
        if (!resolved) {
          missing.push('序号 ' + skinId + ' 的 ' + type + '：' + declared);
          continue;
        }
        resolvedCount++;
        const sourceKey = keyOf(resolved);
        const existing = bindingsBySource[sourceKey];
        if (existing && existing.groupKey !== groupKey) {
          throw new Error('同一 SWF 被多个配置条目引用：' + resolved);
        }
        if (!existing) {
          bindingsBySource[sourceKey] = {
            entry:entry,
            entryIndex:entryIndex,
            groupKey:groupKey,
            types:[],
          };
        }
        if (bindingsBySource[sourceKey].types.indexOf(type) < 0) {
          bindingsBySource[sourceKey].types.push(type);
        }
        if (!sourceKeys.has(sourceKey)) {
          sources.push(resolved);
          sourceKeys.add(sourceKey);
        }
      }
      if (!resolvedCount) missing.push('序号 ' + skinId + ' 没有可用的本地 SWF');
    }
    if (missing.length) {
      throw new Error('配置引用的文件不完整，未修改皮肤库：\n' + missing.slice(0, 8).join('\n') +
        (missing.length > 8 ? '\n另有 ' + (missing.length - 8) + ' 项' : ''));
    }
    return {
      root:configDir,
      sources:sources,
      swfCount:sources.length,
      configFile:file,
      configEntryCount:skins.length,
      bindingsBySource:bindingsBySource,
      version:version || 1,
    };
  }

  async function buildExportPayload(skins, revision, exportFile, resolveSource) {
    const exportedSkins = [];
    const input = Array.isArray(skins) ? skins : [];
    for (let entryIndex = 0; entryIndex < input.length; entryIndex++) {
      const entry = JSON.parse(JSON.stringify(input[entryIndex] || {}));
      const absoluteFiles = {};
      const resourceFiles = {};
      for (let typeIndex = 0; typeIndex < fileTypes.length; typeIndex++) {
        const type = fileTypes[typeIndex];
        const stored = String(entry.files && entry.files[type] || '').trim();
        if (!stored || /^https?:\/\//i.test(stored)) {
          absoluteFiles[type] = '';
          continue;
        }
        const absolute = path.resolve(resolveSource(stored));
        absoluteFiles[type] = absolute;
        try {
          const stat = await fs.promises.stat(absolute);
          resourceFiles[type] = {
            stored:stored,
            absolute:absolute,
            bytes:stat.isFile() ? stat.size : 0,
            modifiedAt:stat.isFile() ? stat.mtime.toISOString() : '',
          };
        } catch (_) {
          resourceFiles[type] = { stored:stored, absolute:absolute, bytes:0, missing:true };
        }
      }
      entry.absoluteFiles = absoluteFiles;
      entry.resourceFiles = resourceFiles;
      exportedSkins.push(entry);
    }
    return {
      version:3,
      exportedAt:new Date().toISOString(),
      exportRoot:path.dirname(path.resolve(exportFile)),
      managedRoot:path.resolve(currentManagedRoot()),
      revision:Math.max(0, parseInt(revision, 10) || 0),
      skins:exportedSkins,
    };
  }

  return { read:read, buildExportPayload:buildExportPayload };
}

module.exports = { createCustomSkinConfigPackage:createCustomSkinConfigPackage };
