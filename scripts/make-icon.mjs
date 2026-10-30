// Renders resources/brand.svg to the 128x128 PNG the Marketplace requires. Run when the SVG
// changes (npm run icon); the PNG is committed so that building needs no native module.
import sharp from 'sharp';

await sharp('resources/brand.svg', { density: 384 })
  .resize(128, 128)
  .png()
  .toFile('resources/icon.png');
console.log('resources/icon.png');
