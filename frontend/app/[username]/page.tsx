import type { Metadata } from 'next';
import CreatorProfileClient from './CreatorProfileClient';
import { fetchCreatorSummary } from './creator-summary';

type ParamsPromise = Promise<{ username: string }>;

// Mirrors the fallback in components/ShareCard.tsx: there is no shared
// exported SITE_URL constant (layout.tsx's copy is module-local), and
// schema.org url/image fields need to be absolute.
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://support-mee.vercel.app';

export async function generateMetadata({ params }: { params: ParamsPromise }): Promise<Metadata> {
  const { username } = await params;
  const creator = await fetchCreatorSummary(username);

  if (!creator) {
    return { title: 'Creator not found' };
  }

  const name = creator.displayName || creator.username;
  const description = creator.bio?.trim() || `Support ${name} with a tip on SupportMe.`;
  const title = `Support ${name} (@${creator.username})`;

  // og:image / twitter:image come from the generated opengraph-image.tsx and
  // twitter-image.tsx next to this file (a 1200x630 card with the avatar).
  return {
    title,
    description,
    openGraph: {
      title,
      description,
      type: 'profile',
      siteName: 'SupportMe',
      url: `/${creator.username}`,
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
    },
  };
}

export default async function CreatorProfilePage({ params }: { params: ParamsPromise }) {
  const { username } = await params;
  const creator = await fetchCreatorSummary(username);

  return (
    <>
      {creator && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(buildCreatorJsonLd(creator)) }}
        />
      )}
      <CreatorProfileClient params={params} />
    </>
  );
}

function buildCreatorJsonLd(creator: NonNullable<Awaited<ReturnType<typeof fetchCreatorSummary>>>) {
  const name = creator.displayName || creator.username;
  const description = creator.bio?.trim() || `Support ${name} with a tip on SupportMe.`;
  const url = `${SITE_URL}/${creator.username}`;

  return {
    '@context': 'https://schema.org',
    '@type': 'ProfilePage',
    dateModified: new Date().toISOString(),
    mainEntity: {
      '@type': 'Person',
      name,
      description,
      url,
      ...(creator.avatarUrl ? { image: creator.avatarUrl } : {}),
    },
  };
}
