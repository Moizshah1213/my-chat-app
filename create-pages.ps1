# Helper functions
function Write-File {
    param([string]$Path, [string]$Content)
    $dir = Split-Path $Path -Parent
    if ($dir) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    Set-Content -Path $Path -Value $Content 
}

function Write-Page {
    param([string]$Path, [string]$Title, [string]$Description, [string]$Body)
    $src = "d:/saas/apps/site/src/pages"
    $content = @"
---
import Layout from '../layouts/Layout.astro';
---

<Layout title="$Title" description="$Description">
  $Body
</Layout>
"@
    Write-File "$src\$Path" $content
}

# Create directories
$dirs = @("integrations","compare","blog","security","privacy","terms","contact","404","500")
foreach ($d in $dirs) {
    $dir = "d:/saas/apps/site/src/pages/$d"
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
}

# Write pages
Write-Page -Path "features.astro" -Title "Features" -Description "LiveChat features" -Body @"
<h1>Features</h1>
<p>Live chat with customisation.</p>
"@

Write-Page -Path "pricing.astro" -Title "Pricing" -Description "Pricing plans for LiveChat" -Body @"
<h1>Pricing</h1>
<p>Plans for every team size.</p>
"@

Write-Page -Path "integrations/wordpress.astro" -Title "WordPress Integration" -Description "Add LiveChat to WordPress" -Body @"
<h1>WordPress Integration</h1>
<p>Install the official LiveChat WordPress plugin.</p>
"@

Write-Page -Path "integrations/html.astro" -Title "HTML Integration" -Description "Embed LiveChat using plain HTML" -Body @"
<h1>HTML Integration</h1>
<p>Paste the script tag before <code>&lt;/body&gt;</code>.</p>
"@

Write-Page -Path "integrations/react.astro" -Title "React Integration" -Description "Use LiveChat in a React app" -Body @"
<h1>React Integration</h1>
<p>Install the LiveChat React component.</p>
"@

Write-Page -Path "integrations/nextjs.astro" -Title "Next.js Integration" -Description "Add LiveChat to Next.js" -Body @"
<h1>Next.js Integration</h1>
<p>Add the script in _document.js.</p>
"@

Write-Page -Path "integrations/shopify.astro" -Title "Shopify Integration" -Description "Add LiveChat to Shopify" -Body @"
<h1>Shopify Integration</h1>
<p>Use the Shopify app.</p>
"@

Write-Page -Path "integrations/webflow.astro" -Title "Webflow Integration" -Description "Add LiveChat to Webflow" -Body @"
<h1>Webflow Integration</h1>
<p>Use the embed code.</p>
"@

Write-Page -Path "integrations/wix.astro" -Title "Wix Integration" -Description "Add LiveChat to Wix" -Body @"
<h1>Wix Integration</h1>
<p>Use the site manager.</p>
"@

Write-Page -Path "integrations/gtm.astro" -Title="Google Tag Manager Integration" -Description="Send data to LiveChat via GTM" -Body @"
<h1>Google Tag Manager Integration</h1>
<p>Configure a data layer.</p>
"@

Write-Page -Path "compare/[competitor].astro" -Title="Compare Competitor" -Description="Compare with competitors" -Body @"
<h1>Compare</h1>
<p>Comparing with $competitor.</p>
"@

Write-Page -Path "blog.astro" -Title="Blog" -Description="Latest news and articles" -Body @"
<h1>Blog</h1>
<p>Check out our latest posts.</p>
"@

Write-Page -Path "security.astro" -Title="Security" -Description="Security information" -Body @"
<h1>Security</h1>
<p>Security measures.</p>
"@

Write-Page -Path "privacy.astro" -Title="Privacy Policy" -Description="Privacy policy" -Body @"
<h1>Privacy Policy</h1>
<p>Privacy details.</p>
"@

Write-Page -Path "terms.astro" -Title="Terms of Service" -Description="Terms of service" -Body @"
<h1>Terms of Service</h1>
<p>Terms.</p>
"@

Write-Page -Path "contact.astro" -Title="Contact" -Description="Contact us" -Body @"
<h1>Contact</h1>
<p>Get in touch.</p>
"@

Write-Page -Path "404.astro" -Title="404 - Page Not Found" -Description="Page not found" -Body @"
<h1>404</h1>
<p>Page not found.</p>
"@

Write-Page -Path "500.astro" -Title="500 - Server Error" -Description="Server error" -Body @"
<h1>500</h1>
<p>Something went wrong.</p>
"@

# Sitemap and robots
$sitemap = @"
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://chat.example.com/</loc>
  </url>
  <url>
    <loc>https://chat.example.com/features</loc>
  </url>
  <url>
    <loc>https://chat.example.com/pricing</loc>
  </url>
  <url>
    <loc>https://chat.example.com/docs</loc>
  </url>
  <url>
    <loc>https://chat.example.com/contact</loc>
  </url>
</urlset>
"@
$sitemapPath = "d:/saas/apps/site/public/sitemap.xml"
if (-not (Test-Path "d:/saas/apps/site/public")) { New-Item -ItemType Directory -Path "d:/saas/apps/site/public" -Force | Out-Null }
Set-Content -Path $sitemapPath -Value $sitemap 

$robots = @"
User-agent: *
Allow: /
Sitemap: https://chat.example.com/sitemap.xml
"@
$robotsPath = "d:/saas/apps/site/public/robots.txt"
Set-Content -Path $robotsPath -Value $robots 

Write-Host "Pages created successfully."
