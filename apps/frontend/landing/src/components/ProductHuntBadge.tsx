import { useSystemPreferences } from '../hooks/useSystemPreferences';
import { PRODUCT_HUNT_POST_ID, PRODUCT_HUNT_URL } from '../seo/siteMeta';

const UTM = '?utm_source=badge-featured&utm_medium=badge&utm_campaign=badge-scani';

export function ProductHuntBadge() {
  const { theme } = useSystemPreferences();
  const src = `https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=${PRODUCT_HUNT_POST_ID}&theme=${theme}`;
  return (
    <a
      href={`${PRODUCT_HUNT_URL}${UTM}`}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex"
    >
      <img src={src} alt="Scani on Product Hunt — launching June 1, 2026" width={250} height={54} />
    </a>
  );
}
