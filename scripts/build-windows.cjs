const path = require('path');
const fs = require('fs');
const packager = require('electron-packager');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function moveAsideIfLocked(targetDir) {
  if (!fs.existsSync(targetDir)) return null;
  const parent = path.dirname(targetDir);
  const backupName = path.basename(targetDir) + `.rr-bak-${Date.now()}`;
  const backupPath = path.join(parent, backupName);
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      fs.renameSync(targetDir, backupPath);
      return backupPath;
    } catch (error) {
      if (!fs.existsSync(targetDir)) return null;
      if (attempt === 8) throw error;
      await sleep(1000);
    }
  }
  return null;
}

function removeBackupDir(backupPath) {
  if (!backupPath || !fs.existsSync(backupPath)) return;
  try {
    fs.rmSync(backupPath, { recursive: true, force: true });
  } catch {
    // Non-fatal cleanup failure.
  }
}

async function main() {
  const projectRoot = path.resolve(__dirname, '..');
  const outDir = path.join(projectRoot, 'dist');
  const appOutDir = path.join(outDir, 'RootRecordWeatherManager-win32-x64');
  fs.mkdirSync(outDir, { recursive: true });
  const backupDir = await moveAsideIfLocked(appOutDir);

  try {
    const appPaths = await packager({
      dir: projectRoot,
      out: outDir,
      overwrite: true,
      platform: 'win32',
      arch: 'x64',
      asar: true,
      prune: true,
      appCopyright: 'Root Record',
      name: 'RootRecordWeatherManager',
      executableName: 'RootRecordWeatherManager',
      ignore: [
        /^\/dist($|\/)/,
        /^\/scripts($|\/)/,
        /^\/build($|\/)/
      ]
    });

    console.log('Build complete:');
    for (const appPath of appPaths) {
      console.log(`- ${appPath}`);
    }
  } finally {
    removeBackupDir(backupDir);
  }
}

main().catch((error) => {
  console.error('Build failed:', error);
  process.exitCode = 1;
});
