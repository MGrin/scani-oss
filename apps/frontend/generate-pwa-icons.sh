#!/bin/bash
# Generate PWA icons from a simple SVG template
# This creates placeholder icons - you should replace with actual branded icons

# Create a simple SVG icon template
cat > /tmp/scani-icon.svg << 'EOF'
<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <rect width="512" height="512" fill="#1a1f2e" rx="80"/>
  <g transform="translate(256, 256)">
    <circle cx="0" cy="-40" r="60" fill="#4f46e5" opacity="0.8"/>
    <circle cx="50" cy="20" r="50" fill="#06b6d4" opacity="0.8"/>
    <circle cx="-50" cy="20" r="50" fill="#10b981" opacity="0.8"/>
  </g>
  <text x="256" y="420" font-family="Arial, sans-serif" font-size="80" font-weight="bold" fill="#ffffff" text-anchor="middle">SCANI</text>
</svg>
EOF

echo "PWA icon template created at /tmp/scani-icon.svg"
echo ""
echo "To generate proper PWA icons, you can use an online tool like:"
echo "- https://realfavicongenerator.net/"
echo "- https://www.pwabuilder.com/imageGenerator"
echo ""
echo "For now, we'll create placeholder PNG files..."

# Note: This requires imagemagick to be installed
# If not available, we'll create a simple HTML file that uses canvas to generate icons

cat > /tmp/generate-icons.html << 'EOF'
<!DOCTYPE html>
<html>
<head>
  <title>Generate PWA Icons</title>
</head>
<body>
  <h1>PWA Icon Generator</h1>
  <p>Open browser console to download icons</p>
  <canvas id="canvas"></canvas>
  <script>
    const sizes = [72, 96, 128, 144, 152, 192, 384, 512];
    const canvas = document.getElementById('canvas');
    const ctx = canvas.getContext('2d');
    
    sizes.forEach(size => {
      canvas.width = size;
      canvas.height = size;
      
      // Background
      ctx.fillStyle = '#1a1f2e';
      ctx.fillRect(0, 0, size, size);
      
      // Circles
      const scale = size / 512;
      ctx.globalAlpha = 0.8;
      
      ctx.fillStyle = '#4f46e5';
      ctx.beginPath();
      ctx.arc(size/2, size/2 - 40*scale, 60*scale, 0, Math.PI * 2);
      ctx.fill();
      
      ctx.fillStyle = '#06b6d4';
      ctx.beginPath();
      ctx.arc(size/2 + 50*scale, size/2 + 20*scale, 50*scale, 0, Math.PI * 2);
      ctx.fill();
      
      ctx.fillStyle = '#10b981';
      ctx.beginPath();
      ctx.arc(size/2 - 50*scale, size/2 + 20*scale, 50*scale, 0, Math.PI * 2);
      ctx.fill();
      
      // Text
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#ffffff';
      ctx.font = `bold ${80*scale}px Arial`;
      ctx.textAlign = 'center';
      ctx.fillText('SCANI', size/2, 420*scale);
      
      // Download
      canvas.toBlob(blob => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `icon-${size}x${size}.png`;
        a.click();
      });
    });
  </script>
</body>
</html>
EOF

echo "Icon generator HTML created at /tmp/generate-icons.html"
echo "Open this file in a browser to generate and download the icons."
