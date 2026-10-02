// Launches Electron with a clean environment. Some hosts (e.g. VS Code extensions) export
// ELECTRON_RUN_AS_NODE=1, which makes Electron behave as plain Node instead of opening the app.
import { spawn } from 'node:child_process';
import electronPath from 'electron';

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, process.argv.slice(2), { stdio: 'inherit', env });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
