# Website Performance Improvements Checklist

## 🚀 Quick Wins (High Impact, Low Effort)

### Immediate Fixes (Do These First)
- [x] **Enable gzip/Brotli compression** - Add `compression` middleware to Express
  - Install: `npm install compression`
  - Add to `app.js`: `app.use(require('compression')())`
  - Expected: 70-80% reduction in transfer size

- [ ] **Add `defer` to non-critical scripts** - Update `views/javascript.ejs`
  - Add `defer` attribute to script tags that don't need to execute immediately
  - Allows HTML parsing to continue while scripts download

- [ ] **Optimize LinkedIn feed loading** - Update `views/javascript.ejs`
  - Move LinkedIn API call to after page load or use `requestIdleCallback`
  - Don't block initial page render

- [ ] **Add `loading="lazy"` to all images** - Check all EJS templates
  - Already done for some images, ensure all images have this attribute
  - Prevents loading images below the fold until needed

- [ ] **Enable HTTP caching headers** - Already partially done in `app.js`
  - Verify all static assets have proper `Cache-Control` and `Expires` headers
  - Current: Images have 1-year cache, verify JS/CSS do too

## 📦 Medium Effort Improvements

### Asset Optimization
- [ ] **Minify and bundle CSS files** - Currently 2,445 CSS files
  - Create a build process to combine and minify CSS
  - Reduce HTTP requests significantly

- [ ] **Optimize JavaScript bundles** - Review `public/js/bundle/`
  - Ensure `bundle.js` and `bundle2.js` are properly minified
  - Consider splitting into smaller, route-specific bundles

- [ ] **Use CDN for common libraries** - jQuery, D3, etc.
  - Replace local copies with CDN versions (jsDelivr, unpkg, or cdnjs)
  - Benefits: Caching, geographic distribution, parallel downloads

- [ ] **Optimize images** - `public/patric/images/` (5.4MB)
  - Convert to WebP format with fallbacks
  - Compress existing JPG/PNG files
  - Use responsive images (`srcset`)

- [ ] **Optimize Dojo build** - Review `public/js/release.profile.js`
  - Remove unused modules from core layer
  - Split into smaller, lazy-loaded layers
  - Current core.js is 5.5MB - should be much smaller

### Loading Strategy
- [ ] **Implement lazy loading for Dojo modules** - Update build profile
  - Split large layers into smaller chunks
  - Load features on-demand instead of upfront

- [ ] **Add resource hints** - Update `views/header.ejs`
  - Add `<link rel="preconnect">` for external domains
  - Add `<link rel="dns-prefetch">` for CDN resources
  - Add `<link rel="preload">` for critical resources

- [ ] **Optimize Google Fonts loading** - Update `views/header.ejs`
  - Use `font-display: swap` in font loading
  - Consider self-hosting fonts for better control

- [ ] **Defer Google Analytics** - Update `views/javascript.ejs`
  - Load GA asynchronously after page load
  - Use `async` attribute or load in `requestIdleCallback`

## 🏗️ Long-term Architectural Improvements

### Build System Modernization
- [ ] **Evaluate migration from Dojo to modern framework**
  - Consider React, Vue, or Svelte
  - Modern frameworks have better tree-shaking and code-splitting
  - This is a major undertaking but would solve many performance issues

- [ ] **Implement proper code splitting** - If staying with Dojo
  - Split by route/feature
  - Load only what's needed for each page
  - Current: Everything loads upfront

- [ ] **Set up modern bundler** - Webpack, Vite, or Rollup
  - Better optimization than current Dojo build
  - Tree-shaking, minification, compression built-in
  - Better development experience

### Advanced Optimizations
- [ ] **Implement Service Worker** - For offline caching
  - Cache static assets
  - Reduce repeat visit load times
  - Already have some service workers in `public/worker/` - expand usage

- [ ] **Set up HTTP/2 Server Push** - Or use preload hints
  - Push critical resources to browser
  - Reduce round-trip time

- [ ] **Implement critical CSS inlining** - Extract above-the-fold CSS
  - Inline critical CSS in `<head>`
  - Load rest asynchronously

- [ ] **Add performance monitoring** - Already have New Relic
  - Set up Real User Monitoring (RUM)
  - Track Core Web Vitals (LCP, FID, CLS)
  - Set up alerts for performance regressions

- [ ] **Optimize API calls** - Review route handlers
  - Implement request batching where possible
  - Add response caching for static data
  - Use GraphQL or similar to reduce over-fetching

## 📊 Monitoring & Validation

### After Each Improvement
- [ ] **Measure before/after** - Use Lighthouse, WebPageTest, or Chrome DevTools
  - Track: First Contentful Paint (FCP), Largest Contentful Paint (LCP)
  - Track: Time to Interactive (TTI), Total Blocking Time (TBT)
  - Track: Bundle sizes and transfer sizes

- [ ] **Test on slow connections** - Use Chrome DevTools throttling
  - 3G/4G simulation
  - Ensure improvements help real-world users

- [ ] **Verify compression is working** - Check response headers
  - `Content-Encoding: gzip` or `br` should be present
  - Compare file sizes before/after compression

## 🎯 Priority Order Summary

1. **Enable compression** (5 minutes, 70% improvement)
2. **Add defer to scripts** (15 minutes)
3. **Optimize LinkedIn feed** (30 minutes)
4. **Use CDN for libraries** (1 hour)
5. **Optimize Dojo build** (4-8 hours)
6. **Bundle and minify CSS** (4-8 hours)
7. **Optimize images** (2-4 hours)
8. **Implement code splitting** (1-2 weeks)
9. **Consider framework migration** (3-6 months)

## 📝 Notes

- Current total JS size: ~541MB (uncompressed)
- Current core layer: 5.5MB (should be <500KB)
- Current bundle files: 2.4MB total
- Target: <1MB total JavaScript on initial load
- Target: <3 seconds Time to Interactive on 3G

---

**Last Updated**: 2025-01-15
**Status**: In Progress

