#!/usr/bin/env node

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

console.log('🚀 Building Mozu On-Premise App for Windows...');

try {
  // Check if we're on the right platform or have wine
  if (process.platform !== 'win32') {
    console.log('ℹ️  Cross-platform build: Building Windows app from ' + process.platform);
  }

  // Clean previous builds
  console.log('🧹 Cleaning previous builds...');
  if (fs.existsSync('dist')) {
    execSync('rm -rf dist', { stdio: 'inherit' });
  }
  if (fs.existsSync('release')) {
    execSync('rm -rf release', { stdio: 'inherit' });
  }

  // Build the app
  console.log('🔨 Building application...');
  execSync('npm run build', { stdio: 'inherit' });

  // Create Windows installer
  console.log('📦 Creating Windows installer...');
  execSync('npm run dist:win', { stdio: 'inherit' });

  console.log('✅ Windows build complete!');
  console.log('📁 Output files:');
  
  const releaseDir = path.join(__dirname, 'release');
  if (fs.existsSync(releaseDir)) {
    const files = fs.readdirSync(releaseDir).filter(f => f.includes('win') || f.endsWith('.exe'));
    files.forEach(file => {
      const stats = fs.statSync(path.join(releaseDir, file));
      const size = (stats.size / 1024 / 1024).toFixed(2);
      console.log(`   ${file} (${size} MB)`);
    });
  }

  console.log('');
  console.log('📋 Next steps:');
  console.log('1. Test the installer on a Windows machine');
  console.log('2. Distribute the .exe file to teachers');
  console.log('3. Provide installation guide');

} catch (error) {
  console.error('❌ Build failed:', error.message);
  process.exit(1);
}