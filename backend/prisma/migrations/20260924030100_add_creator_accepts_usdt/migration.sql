-- AlterTable
-- Defaults to false (unlike acceptsXlm/acceptsUsdc, which default true) so an
-- existing creator doesn't silently start accepting a brand-new asset they
-- never configured — they opt in from Settings like any other asset toggle.
ALTER TABLE "Creator" ADD COLUMN "acceptsUsdt" BOOLEAN NOT NULL DEFAULT false;
