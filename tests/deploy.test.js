'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assertAdditive } = require('../scripts/deploy');
test('reuses only an HTTPS tunnel pointing to the local production port',()=>{
    const {tunnelUrl}=require('../scripts/deploy');
    const tunnel=(addr,url='https://example.ngrok-free.dev')=>({config:{addr},public_url:url});
    assert.equal(tunnelUrl({tunnels:[tunnel('http://127.0.0.1:3000')]}),'https://example.ngrok-free.dev');
    assert.equal(tunnelUrl({tunnels:[tunnel('localhost:3000')]}),'https://example.ngrok-free.dev');
    for(const entry of [tunnel('http://127.0.0.1:13000'),tunnel('https://external.example:3000'),tunnel('localhost:3000','http://example.ngrok-free.dev')])assert.equal(tunnelUrl({tunnels:[entry]}),null);
    assert.equal(tunnelUrl({}),null);
});

test('permits schema additions for live deployment', () => {
    assert.doesNotThrow(() => assertAdditive('-- add optional field\nALTER TABLE `clients` ADD COLUMN `reference` VARCHAR(40) NULL; CREATE INDEX `reference_idx` ON `clients` (`reference`);', 'safe'));
    assert.doesNotThrow(() => assertAdditive('CREATE TABLE `notes` (`id` INTEGER NOT NULL);', 'safe'));
});
test('blocks data deletion, rewrites and mixed destructive ALTER operations', () => {
    for (const sql of [
        'DROP TABLE clients;', 'TRUNCATE clients;', 'DELETE FROM clients;',
        'UPDATE clients SET name = NULL;', 'INSERT INTO clients VALUES (1);',
        'ALTER TABLE clients DROP COLUMN name;',
        'ALTER TABLE clients MODIFY name VARCHAR(1);',
        'ALTER TABLE clients ADD COLUMN extra INT, DROP COLUMN name;',
        '/* comment */ DELETE FROM clients;', 'SET FOREIGN_KEY_CHECKS=0;'
    ]) assert.throws(() => assertAdditive(sql, 'unsafe'), /not strictly additive/);
});
test('does not discard MySQL executable comments as harmless documentation', () => {
    assert.throws(() => assertAdditive('CREATE TABLE t (id INT); /*! DELETE FROM clients */;', 'unsafe'), /executable comments/);
});
