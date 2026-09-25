import request from "supertest";
import app from "../../app";
import prisma from "../../prisma";

jest.mock("../../prisma", () => ({
  __esModule: true,
  default: {
    creator: {
      findMany: jest.fn(),
    },
  },
}));

describe("SEO Routes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("GET /sitemap.xml", () => {
    it("returns valid XML with static pages and current dynamic creator profiles", async () => {
      (prisma.creator.findMany as jest.Mock).mockResolvedValueOnce([
        { username: "alice", updatedAt: new Date("2026-04-10T10:00:00Z") },
        { username: "bob_builder", updatedAt: new Date("2026-04-12T15:30:00Z") },
      ]);

      const res = await request(app).get("/sitemap.xml");

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("application/xml");
      expect(res.text).toContain('<?xml version="1.0" encoding="UTF-8"?>');
      expect(res.text).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');

      // Verify static indexable pages
      expect(res.text).toContain("<loc>https://supportme.app/</loc>");
      expect(res.text).toContain("<loc>https://supportme.app/discover</loc>");
      expect(res.text).toContain("<loc>https://supportme.app/activity</loc>");

      // Verify dynamic creator profile URLs
      expect(res.text).toContain("<loc>https://supportme.app/alice</loc>");
      expect(res.text).toContain("<lastmod>2026-04-10</lastmod>");
      expect(res.text).toContain("<loc>https://supportme.app/bob_builder</loc>");
      expect(res.text).toContain("<lastmod>2026-04-12</lastmod>");
    });

    it("stays up to date when new creators join", async () => {
      (prisma.creator.findMany as jest.Mock).mockResolvedValueOnce([
        { username: "newly_joined_creator", updatedAt: new Date("2026-04-15T08:00:00Z") },
      ]);

      const res = await request(app).get("/sitemap.xml");

      expect(res.status).toBe(200);
      expect(res.text).toContain("<loc>https://supportme.app/newly_joined_creator</loc>");
      expect(res.text).toContain("<lastmod>2026-04-15</lastmod>");
    });

    it("is also reachable at /api/sitemap.xml", async () => {
      (prisma.creator.findMany as jest.Mock).mockResolvedValueOnce([]);

      const res = await request(app).get("/api/sitemap.xml");

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("application/xml");
    });
  });

  describe("GET /robots.txt", () => {
    it("allows public pages and disallows private/dashboard/auth routes", async () => {
      const res = await request(app).get("/robots.txt");

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/plain");

      // Verify allowed public routes
      expect(res.text).toContain("Allow: /");
      expect(res.text).toContain("Allow: /discover");
      expect(res.text).toContain("Allow: /activity");

      // Verify blocked private/auth routes
      expect(res.text).toContain("Disallow: /app");
      expect(res.text).toContain("Disallow: /dashboard");
      expect(res.text).toContain("Disallow: /settings");
      expect(res.text).toContain("Disallow: /auth");
      expect(res.text).toContain("Disallow: /admin");
      expect(res.text).toContain("Disallow: /api/");

      // Verify sitemap directive
      expect(res.text).toContain("Sitemap: https://supportme.app/sitemap.xml");
    });

    it("is also reachable at /api/robots.txt", async () => {
      const res = await request(app).get("/api/robots.txt");

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/plain");
    });
  });
});
