#!/usr/bin/env node
// Contrôle bloquant des dépendances de production (SEC-42).
//
// Échoue (code 1) si `npm audit --omit=dev` signale un avis élevé ou critique
// absent de security/audit-exceptions.json, ou si une exception a dépassé sa
// date de revue (`reviewBy`). Remplace `npm audit --audit-level=high`, qui ne
// sait pas distinguer un risque analysé et accepté d'un nouveau risque.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const BLOCKING = new Set(['high', 'critical']);
const exceptions = JSON.parse(readFileSync(new URL('../security/audit-exceptions.json', import.meta.url), 'utf8')).exceptions;
const today = new Date().toISOString().slice(0, 10);

let raw;
try {
  // Lancé par `npm run audit:gate` : npm fournit le chemin de sa CLI, exécutée sans shell.
  const npmCli = process.env.npm_execpath;
  const [cmd, args] = npmCli ? [process.execPath, [npmCli, 'audit', '--omit=dev', '--json']] : ['npm', ['audit', '--omit=dev', '--json']];
  raw = execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
} catch (err) {
  // npm audit sort en code ≠ 0 dès qu'il trouve un avis : le JSON reste sur stdout.
  raw = err.stdout;
}
const report = JSON.parse(raw);

const advisories = new Map();
for (const vuln of Object.values(report.vulnerabilities ?? {})) {
  for (const via of vuln.via) {
    if (typeof via !== 'object') continue;
    const id = via.url?.split('/').pop();
    if (id && !advisories.has(id)) advisories.set(id, { id, name: via.name, severity: via.severity, title: via.title });
  }
}

const failures = [];
for (const exception of exceptions) {
  if (exception.reviewBy < today) failures.push(`Exception expirée (${exception.reviewBy}) : ${exception.id} ${exception.package} — réévaluer ou corriger.`);
}
for (const adv of advisories.values()) {
  if (!BLOCKING.has(adv.severity)) continue;
  if (!exceptions.some((e) => e.id === adv.id)) failures.push(`Avis ${adv.severity} non accepté : ${adv.id} ${adv.name} — ${adv.title}`);
}

for (const adv of advisories.values()) {
  const accepted = exceptions.some((e) => e.id === adv.id);
  console.log(`${accepted ? 'accepté ' : 'signalé '} ${adv.severity.padEnd(8)} ${adv.id} ${adv.name}`);
}
if (failures.length) {
  console.error(`\nAudit des dépendances de production : ÉCHEC\n - ${failures.join('\n - ')}`);
  process.exit(1);
}
console.log(`\nAudit des dépendances de production : OK (${advisories.size} avis, tous analysés ou non bloquants).`);
