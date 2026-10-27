import type { IndicatorId } from '../types.ts';

/**
 * Threat Intel pivot links (N7, #20): VirusTotal, AbuseIPDB, urlscan.io,
 * Shodan, plus user-defined custom providers. This is the only feature in
 * the project that sends customer data to a third party, so it is held to a
 * stricter rule than the rest of `core/`: pure data in, data out, nothing
 * that could ever turn into a request on its own.
 *
 * Pure: no DOM, no storage, no network. A link here is only ever
 * `{ label, url }` — building it never visits `url`, never prefetches a
 * favicon, never pings the provider. The settings read (`ti.providers`,
 * `ti.custom`) and the `<a href>` rendering live in the UI layer
 * (`ui/panel/params-view.ts`, `ui/panel/settings-view.ts`), not here.
 */

// ── Provider model ──

export interface TiProvider {
  readonly id: string;
  readonly label: string;
  /** One template per indicator type this provider supports; `{value}` is substituted in buildTiLinks(). */
  readonly templates: Partial<Record<IndicatorId, string>>;
}

export interface TiLink {
  readonly providerId: string;
  readonly label: string;
  readonly url: string;
}

// ── Built-in providers — ALL disabled by default, see settings.ts `ti.providers` ──

export const BUILTIN_TI_PROVIDERS: readonly TiProvider[] = [
  {
    id: 'virustotal',
    label: 'VirusTotal',
    templates: {
      ip: 'https://www.virustotal.com/gui/ip-address/{value}',
      domain: 'https://www.virustotal.com/gui/domain/{value}',
      // `{value}` is NOT the raw URL here: VirusTotal expects the base64url
      // id of the URL (see toVirusTotalUrlId below, substituted in buildTiLinks).
      url: 'https://www.virustotal.com/gui/url/{value}',
      hash: 'https://www.virustotal.com/gui/file/{value}',
    },
  },
  {
    id: 'abuseipdb',
    label: 'AbuseIPDB',
    templates: { ip: 'https://www.abuseipdb.com/check/{value}' },
  },
  {
    id: 'urlscan',
    label: 'urlscan.io',
    templates: {
      domain: 'https://urlscan.io/search/#domain:{value}',
      url: 'https://urlscan.io/search/#page.url:{value}',
    },
  },
  {
    id: 'shodan',
    label: 'Shodan',
    templates: { ip: 'https://www.shodan.io/host/{value}' },
  },
] as const;

// ── Custom provider validation (used by the settings UI before storing one) ──

/**
 * A custom template must use `https://` (never `http://` or any other
 * scheme — this is the one path in the project that deliberately sends a
 * value off-browser, so the transport itself must be encrypted) and must
 * contain the `{value}` token, or the link would silently send nothing
 * useful once built.
 */
export function isValidTiTemplate(template: string): boolean {
  return template.startsWith('https://') && template.includes('{value}');
}

// ── VirusTotal's URL id: base64url of the URL itself, computed locally ──

/**
 * VirusTotal identifies a submitted URL by the base64url encoding of the URL
 * string (no `=` padding), not by the URL itself — see
 * https://docs.virustotal.com/reference/url-info. Computed locally so no
 * request is ever needed to resolve it before building the link.
 */
export function toVirusTotalUrlId(url: string): string {
  const bytes = new TextEncoder().encode(url);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ── Link building ──

/**
 * Build one link per provider that is both enabled (`enabledIds`, i.e.
 * `ti.providers`) and has a template for `type`. `providers` is the full
 * list to consider — built-ins plus custom ones from `ti.custom` — passed in
 * by the caller, since this module never reads settings itself.
 *
 * Returns `[]` whenever `enabledIds` is empty (a fresh install) or `value`
 * is blank: no links, by construction, until the analyst opts in.
 */
export function buildTiLinks(
  providers: readonly TiProvider[],
  enabledIds: readonly string[],
  value: string,
  type: IndicatorId,
): TiLink[] {
  if (!value) return [];
  const enabled = new Set(enabledIds);
  const links: TiLink[] = [];

  for (const provider of providers) {
    if (!enabled.has(provider.id)) continue;
    const template = provider.templates[type];
    if (!template || !isValidTiTemplate(template)) continue;

    const substitute =
      provider.id === 'virustotal' && type === 'url' ? toVirusTotalUrlId(value) : encodeURIComponent(value);
    links.push({
      providerId: provider.id,
      label: provider.label,
      url: template.split('{value}').join(substitute),
    });
  }

  return links;
}
