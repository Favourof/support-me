import { Router, Request, Response } from "express";
import prisma from "../prisma";
import { asyncHandler } from "../middleware/asyncHandler";

const router = Router();

const getBaseUrl = (): string =>
  (process.env.APP_URL || "https://supportme.app").replace(/\/$/, "");

/**
 * Escapes XML special characters for safety in sitemap XML.
 */
function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * GET /sitemap.xml
 * Returns dynamic sitemap.xml listing all public indexable pages and creator profile URLs.
 * Dynamically queries current creators from the database so newly joined creators are
 * immediately discoverable by search engine crawlers.
 */
router.get(
  "/sitemap.xml",
  asyncHandler(async (_req: Request, res: Response) => {
    const baseUrl = getBaseUrl();
    const nowIso = new Date().toISOString().split("T")[0];

    // Static public pages
    const staticPages = [
      { loc: `${baseUrl}/`, changefreq: "daily", priority: "1.0", lastmod: nowIso },
      { loc: `${baseUrl}/discover`, changefreq: "daily", priority: "0.8", lastmod: nowIso },
      { loc: `${baseUrl}/activity`, changefreq: "hourly", priority: "0.7", lastmod: nowIso },
    ];

    // Dynamic public creator profile pages
    const creators = await prisma.creator.findMany({
      select: {
        username: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: "desc" },
    });

    const creatorPages = creators.map((c) => ({
      loc: `${baseUrl}/${encodeURIComponent(c.username)}`,
      lastmod: (c.updatedAt ? new Date(c.updatedAt) : new Date()).toISOString().split("T")[0],
      changefreq: "weekly",
      priority: "0.9",
    }));

    const allPages = [...staticPages, ...creatorPages];

    const xmlUrls = allPages
      .map(
        (page) => `  <url>
    <loc>${escapeXml(page.loc)}</loc>
    <lastmod>${page.lastmod}</lastmod>
    <changefreq>${page.changefreq}</changefreq>
    <priority>${page.priority}</priority>
  </url>`
      )
      .join("\n");

    const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${xmlUrls}
</urlset>`;

    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    return res.send(sitemapXml);
  })
);

/**
 * GET /robots.txt
 * Instructs search crawlers which paths may be indexed (public pages) and
 * disallows indexing of private, authenticated, settings, dashboard, and API endpoints.
 */
router.get("/robots.txt", (_req: Request, res: Response) => {
  const baseUrl = getBaseUrl();

  const robotsTxt = `# SupportMe Robots Exclusion Standard
User-agent: *
Allow: /
Allow: /discover
Allow: /activity

# Disallow private user spaces and administrative routes
Disallow: /app
Disallow: /app/
Disallow: /dashboard
Disallow: /dashboard/
Disallow: /settings
Disallow: /settings/
Disallow: /auth
Disallow: /auth/
Disallow: /admin
Disallow: /admin/
Disallow: /api/

# Sitemap location
Sitemap: ${baseUrl}/sitemap.xml
`;

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  return res.send(robotsTxt);
});

export default router;
