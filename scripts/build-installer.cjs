const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function runOrThrow(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false, ...options });
  if (result.status !== 0) {
    throw new Error(`${command} failed with exit code ${result.status}`);
  }
}

function findInnoCompiler() {
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Inno Setup 6', 'ISCC.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'Inno Setup 6', 'ISCC.exe'),
    path.join(process.env.ProgramFiles || '', 'Inno Setup 6', 'ISCC.exe')
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function collectSignTargets(distDir, installerPath) {
  const targets = [];
  if (fs.existsSync(distDir)) {
    const stack = [distDir];
    while (stack.length) {
      const current = stack.pop();
      const entries = fs.readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
          continue;
        }
        const ext = path.extname(entry.name).toLowerCase();
        if (ext === '.exe' || ext === '.dll') targets.push(full);
      }
    }
  }
  if (installerPath && fs.existsSync(installerPath)) targets.push(installerPath);
  return targets;
}

function findLatestInstaller(outputDir) {
  if (!fs.existsSync(outputDir)) return null;
  const files = fs
    .readdirSync(outputDir)
    .filter((name) => /^RootRecordWeatherSetup-.*\.exe$/i.test(name))
    .map((name) => ({
      path: path.join(outputDir, name),
      mtimeMs: fs.statSync(path.join(outputDir, name)).mtimeMs
    }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files.length ? files[0].path : null;
}

function main() {
  const projectRoot = path.resolve(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  const version = String(pkg.version || '1.0.0');
  const sign = process.argv.includes('--sign');

  console.log('Building Electron app folder...');
  runOrThrow(process.execPath, [path.join(projectRoot, 'scripts', 'build-windows.cjs')], { cwd: projectRoot });

  const iscc = findInnoCompiler();
  if (!iscc) {
    throw new Error('ISCC.exe not found. Install Inno Setup 6 first.');
  }

  const issPath = path.join(projectRoot, 'build', 'installer.iss');
  console.log('Compiling installer wizard with Inno Setup...');
  runOrThrow(iscc, [`/DAppVersion=${version}`, issPath], { cwd: path.join(projectRoot, 'build') });

  const installerPath = findLatestInstaller(path.join(projectRoot, 'build', 'output'));
  if (!installerPath) {
    throw new Error('Installer output not found in build/output.');
  }
  console.log(`Installer created: ${installerPath}`);

  if (!sign) return;

  const businessManagerRoot = path.resolve(projectRoot, '..', 'Root Record Business Manager', 'Root Record Business Manager');
  const signScript = path.join(businessManagerRoot, 'build', 'sign_release_azure.ps1');
  if (!fs.existsSync(signScript)) {
    throw new Error(`Signing script not found: ${signScript}`);
  }

  const distDir = path.join(projectRoot, 'dist', 'RootRecordWeatherManager-win32-x64');
  const targets = collectSignTargets(distDir, installerPath);
  if (!targets.length) {
    throw new Error('No signable targets found for Weather Manager.');
  }

  console.log(`Signing ${targets.length} files using Azure Trusted Signing...`);
  runOrThrow(
    'powershell',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      signScript,
      '-SkipExe',
      '-SkipInstaller',
      '-StopRunningApp',
      '-ExtraFiles',
      ...targets
    ],
    { cwd: businessManagerRoot }
  );
}

try {
  main();
} catch (error) {
  console.error(error.message || error);
  process.exit(1);
}
