const fs = require('fs');
const path = require('path');

const dist = path.join(__dirname, 'dist');
if (!fs.existsSync(dist)) fs.mkdirSync(dist);

// Read index.html and inject env vars
let html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

const replacements = {
  'YOUR_SUPABASE_URL': process.env.SUPABASE_URL || 'https://asdunkqodixbhbohxtuq.supabase.co',
  'YOUR_SUPABASE_ANON_KEY': process.env.SUPABASE_ANON_KEY || ''
};

for (const [placeholder, value] of Object.entries(replacements)) {
  if (placeholder === 'YOUR_SUPABASE_ANON_KEY' && !value) {
    console.error('ERROR: SUPABASE_ANON_KEY env var is not set');
    process.exit(1);
  }
  html = html.replace(new RegExp(placeholder, 'g'), value);
}

fs.writeFileSync(path.join(dist, 'index.html'), html);

// Copy guided-tour.html (no env injection needed)
const tourSrc = path.join(__dirname, 'guided-tour.html');
if (fs.existsSync(tourSrc)) {
  fs.copyFileSync(tourSrc, path.join(dist, 'guided-tour.html'));
  console.log('Copied guided-tour.html to dist/');
}

console.log('Build complete — dist/ written with env vars injected');
