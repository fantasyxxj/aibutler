// 勘定一个 class 里各成员的行边界(含其前置注释块), 供拆包脚本切片用。
// 用法: node tools/scan-class-members.js <file> <classDeclLine> <classEndLine>
const fs = require('fs');
const [, , file, sLine, eLine] = process.argv;
const lines = fs.readFileSync(file, 'utf8').split('\n');
const bodyStart = Number(sLine) + 1;      // class 声明行的下一行
const bodyEnd = Number(eLine) - 1;        // 收尾 } 的上一行

const MEMBER = /^  (?:async\s+|get\s+|set\s+|static\s+)*[A-Za-z_$][\w$]*\s*[(=]/;
const starts = [];
for (let i = bodyStart; i <= bodyEnd; i++) {
  if (MEMBER.test(lines[i - 1])) starts.push(i);
}

// 把成员前面紧挨着的注释块划给这个成员
const cuts = starts.map((s) => {
  let c = s;
  while (c - 1 >= bodyStart && /^\s*\/\//.test(lines[c - 2])) c--;
  return c;
});

const out = starts.map((s, i) => ({
  name: (lines[s - 1].match(/([A-Za-z_$][\w$]*)\s*[(=]/) || [])[1],
  decl: s,
  from: cuts[i],
  to: (i + 1 < cuts.length ? cuts[i + 1] - 1 : bodyEnd),
}));
console.log(JSON.stringify(out, null, 1));
