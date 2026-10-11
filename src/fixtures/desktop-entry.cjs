// Offline stand-in for the Node proxy entry; no network or model calls.
const { spawn } = require('node:child_process');
if (process.env.JEV_TEST_STREAMING === '1') {
  process.stdin.on('data', data => process.stdout.write(data));
} else if (process.env.JEV_TEST_DESCENDANT === '1') {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
  console.log(JSON.stringify({ childPid: child.pid, nodePid: process.pid }));
  setInterval(()=>{},1000);
} else {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', data => { input += data; });
  process.stdin.on('end', () => console.log(JSON.stringify({ args: process.argv.slice(2), input })));
}
