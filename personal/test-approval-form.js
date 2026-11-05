require('./host-wiring');   // 个人版宿主接线: 直接 require core 模块的进程都得先接
const fs = require('fs');
const db = require('../core/db');
const commands = require('../core/commands');

// Setup: create a manager pointing to the actual plugin-db directory
const controlDir = require('path').join(require('os').homedir(), '.butler-dev');
const dataDir = require('path').join(require('os').homedir(), '.butler-dev');
const mgr = db.create({ controlDir, dataDir });

async function test() {
  const pkg = 'approval-form';

  // Step 1: create table (run)
  const createResult = mgr.runOp(pkg, 'run',
    'CREATE TABLE IF NOT EXISTS approvals(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, type TEXT, amount TEXT, date TEXT, note TEXT)',
    []
  );
  console.log('CREATE TABLE:', JSON.stringify(createResult));

  // Step 2: insert test data (run)
  const insertResult = mgr.runOp(pkg, 'run',
    'INSERT INTO approvals(name, type, amount, date, note) VALUES (?, ?, ?, ?, ?)',
    ['张三', '差旅报销', '1500.00', '2026-08-22', '测试数据']
  );
  console.log('INSERT:', JSON.stringify(insertResult));

  // Step 3: select to verify (query)
  const rows = mgr.runOp(pkg, 'query',
    'SELECT * FROM approvals',
    []
  );
  console.log('SELECT result:', JSON.stringify(rows, null, 2));

  // Step 4: insert second row
  const insert2 = mgr.runOp(pkg, 'run',
    'INSERT INTO approvals(name, type, amount, date, note) VALUES (?, ?, ?, ?, ?)',
    ['李四', '采购申请', '3200.50', '2026-08-21', '办公用品']
  );
  console.log('INSERT2:', JSON.stringify(insert2));

  // Step 5: final select
  const finalRows = mgr.runOp(pkg, 'query',
    'SELECT * FROM approvals ORDER BY id',
    []
  );
  console.log('FINAL SELECT:', JSON.stringify(finalRows, null, 2));
}

test().catch(e => console.error('ERROR:', e.message));
