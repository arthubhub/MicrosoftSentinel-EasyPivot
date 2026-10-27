# EasyPivot — Plan de développement pour Claude Code

Oct 20, 2026 · @eddy

## Mode d'emploi

Ce document sert de cahier des charges à Claude Code : exporte-le en Markdown, place-le dans le dépôt, puis fais avancer le projet une phase à la fois. L'étape 0 (format des échanges de requêtes) a été relevée le 21/10/2026 pour le cas nominal. Erreurs, troncature, bouton Run et éditeur Sentinel ont été relevés le même jour ; seuls des points facultatifs restent ouverts (liste « Informations encore manquantes »).

1. Exporter ce document en Markdown et le copier dans le dépôt sous `docs/PLAN-DEV.md`.
2. Créer `CLAUDE.md` à la racine avec le contenu ci-dessous (Claude Code le lit à chaque session).
3. Lancer Claude Code dans le dépôt et donner le prompt de la phase en cours (section « Plan par phases »).
4. Après chaque phase : `npm run check`, installer `dist/sentinel-easypivot.user.js` dans Tampermonkey, dérouler la checklist de vérification, puis commit.
5. Quand l'étape 0 est faite, compléter le gabarit « Format observé » dans `docs/PLAN-DEV.md` avant de lancer la phase 3.

Contenu proposé pour `CLAUDE.md` :

```markdown
# EasyPivot — consignes pour Claude Code

- Lire docs/PLAN-DEV.md avant toute modification ; ne travailler que sur la phase demandée.
- Commandes : `npm run typecheck`, `npm run build`, `npm run check` (doit passer avant chaque commit).
- Architecture : src/core = logique pure sans DOM ; src/platforms = adaptateurs Sentinel / Defender ; src/ui = composants.
- Toute nouvelle chaîne d'interface passe par `t()` (src/i18n), en français et en anglais.
- Ne jamais stocker ni journaliser de token, d'en-tête Authorization ou de cookie.
- Ne jamais inclure de valeur d'IOC, d'identifiant de tenant ni de table `_CL` dans ce qui sort du navigateur (issues, liens, logs de debug).
- Le format des échanges de requêtes n'est connu que via la section « Format observé » du plan : ne pas deviner d'endpoint.
- Pas de tests automatisés dans ce projet : décrire dans le message de commit ce qui a été vérifié à la main.
- Garder le style existant : commentaires courts en anglais dans le code, interface en français/anglais.
```

## Contexte : l'existant

EasyPivot est un userscript Tampermonkey (TypeScript, bundle IIFE Vite) qui ajoute une entrée « Pivot » au menu des cellules de résultats et injecte dans l'éditeur une requête KQL pré-remplie. Le code tient en 4 couches ; les fichiers marqués ★ sont ceux que le plan modifie le plus.

| Couche | Fichiers | Rôle actuel |
| --- | --- | --- |
| Entrée | `main.ts` ★, `config.ts` ★, `types.ts` ★ | Détection plateforme, observateurs, constantes, types |
| Adaptateurs | `platforms/sentinel.ts` + `ag-grid.ts`, `platforms/defender.ts` + `fluent-grid.ts` ★ | Lecture cellule/ligne depuis le DOM, menu natif, bouton |
| Core pur | `core/pivot.ts` ★, `core/catalog-format.ts` | Détection par regex, remplissage des placeholders, parsing date/durée |
| Core état | `core/rules-catalog.ts` ★, `core/investigation.ts` ★, `core/storage.ts`, `core/editor-bridge.ts` ★ | Cache catalogue 12 h, journal (30 snapshots), Monaco |
| UI | `ui/pivot-trigger.ts`, `ui/pivot-menu.ts` ★ (623 lignes), `ui/button.ts`, `ui/notification.ts` | Accroche du menu, panneau Pivot, bouton, toasts |

Les 5 workflows actuels :

- **W1 Démarrage** : plateforme détectée par le hostname → thème, styles, catalogue (cache, sinon intégré, rafraîchi en arrière-plan) → un MutationObserver injecte ou retire le bouton.
- **W2 Pivot depuis une cellule** : clic droit (capture) → lecture de la cellule et de la ligne visible → entrée ajoutée au menu natif → panneau → règle choisie → `fillQuery` → snapshot → requête ajoutée à la fin de l'éditeur.
- **W3 Journal** : liste plate de snapshots ; retour à un événement, pivot sur un autre champ, restauration de la requête source.
- **W4 Catalogue** : URL configurable, format complet ou plat, statut dans les paramètres.
- **W5 Build/release** : `npm run check`, en-tête ajouté par un plugin Vite, release sur merge (pipeline absent de l'archive).

## Règles du projet

Ces règles priment sur tout le reste du plan ; Claude Code doit les respecter dans chaque phase.

1. **Aucune donnée sensible ne sort du navigateur sans action explicite.** Issues GitHub : type d'indicateur, table, colonne, plateforme uniquement. Jamais de valeur d'IOC, d'identifiant de tenant/workspace, de nombre de lignes ni de nom de client.
2. **Tables personnalisées `_CL` exclues** : ni dans les schémas publiés, ni dans `locations`, ni dans les issues. Filtre systématique `/_CL$/`.
3. **Aucun token stocké ni journalisé** : en-têtes `Authorization`, cookies et jetons restent hors du stockage, des logs et des exports.
4. **Pas de requête envoyée dans le dos de l'utilisateur par défaut** : la capture est passive ; l'exécution automatique et les requêtes de contexte sont des options désactivées par défaut.
5. **Pas de tests automatisés** (choix du projet) : `npm run check` + checklist manuelle. Les fonctions pures restent dans `src/core` pour pouvoir être vérifiées à la main dans la console.
6. **i18n d'abord** : aucune nouvelle chaîne en dur ; tout passe par `t()`.
7. **Ne pas deviner les endpoints** : tout ce qui touche aux échanges de requêtes s'appuie sur la section « Format observé » remplie à l'étape 0.
8. **Rétrocompatibilité du stockage** : toute migration (snapshots → cas) garde l'ancienne clé tant que la migration n'est pas confirmée, et propose un export avant.

## Étape 0 : récupérer le format des échanges de requêtes

Tu fais cette étape à la main sur ton poste (pas sur le VPS), avec un userscript temporaire qui n'enregistre que la *forme* des requêtes et réponses : les valeurs sont remplacées par leur type et leur longueur, et aucun en-tête n'est lu au-delà de son nom. Tu reportes ensuite le résultat dans le gabarit ci-dessous ; c'est la seule entrée dont Claude Code a besoin pour la phase 3.

### Logger temporaire

L'installer comme second userscript dans Tampermonkey, exécuter une petite requête sur chaque plateforme, puis ouvrir la console (dans Sentinel, choisir le contexte de l'iframe `reactblade` dans le sélecteur de frame). Le désinstaller une fois le gabarit rempli.

```javascript
// ==UserScript==
// @name         EasyPivot - capture logger (temporaire)
// @match        *://security.microsoft.com/*
// @match        *://*.reactblade.portal.azure.net/*
// @run-at       document-start
// @grant        none
// ==/UserScript==
(() => {
  // Adjust if nothing shows up: matched against path and request body
  const KEYWORDS = /query|hunting|kql|search|execute|analytics/i;
  const shape = (v, d = 0) => {
    if (d > 6) return '...';
    if (Array.isArray(v)) return v.length ? [shape(v[0], d + 1), `<array:${v.length}>`] : [];
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).slice(0, 40).map(([k, x]) => [k, shape(x, d + 1)]));
    }
    if (typeof v === 'string') return `<string:${v.length}>`;
    return `<${typeof v}>`;
  };
  const json = (t) => { try { return JSON.parse(t); } catch { return null; } };
  const headerNames = (h) => {
    try { return h ? [...new Headers(h).keys()] : []; } catch { return ['<unreadable>']; }
  };
  const log = (kind, method, url, headers, body, status, text, ms) => {
    const u = new URL(url, location.href);
    const bodyText = typeof body === 'string' ? body : '';
    if (!KEYWORDS.test(u.pathname) && !KEYWORDS.test(bodyText)) return;
    const req = json(bodyText);
    const res = json(text ?? '');
    console.groupCollapsed(`[EP-LOG] ${kind} ${method} ${u.host}${u.pathname} -> ${status} (${ms} ms)`);
    console.log('frame:', location.host, window === window.top ? 'top' : 'iframe');
    console.log('query param names:', [...u.searchParams.keys()]);
    console.log('request header names:', headerNames(headers));
    console.log('request body:', req ? shape(req) : `<${typeof body}>`);
    console.log('response:', res ? shape(res) : `<text:${(text ?? '').length}>`);
    console.groupEnd();
  };
  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const t0 = performance.now();
    const url = typeof input === 'string' ? input : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const res = await origFetch.apply(this, arguments);
    res.clone().text()
      .then((txt) => log('fetch', method, url, init?.headers, init?.body, res.status, txt, Math.round(performance.now() - t0)))
      .catch(() => {});
    return res;
  };
  const open = XMLHttpRequest.prototype.open;
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__ep = { m, u }; return open.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (body) {
    const t0 = performance.now();
    this.addEventListener('loadend', () => {
      let txt = '';
      try { txt = this.responseType === '' || this.responseType === 'text' ? this.responseText : JSON.stringify(this.response); } catch {}
      log('xhr', this.__ep?.m, this.__ep?.u, null, body, this.status, txt, Math.round(performance.now() - t0));
    });
    return send.apply(this, arguments);
  };
  console.log('[EP-LOG] actif dans', location.host, window === window.top ? '(top)' : '(iframe)');
})();
```

### Procédure

1. Sur chaque plateforme, exécuter : une requête simple (`SigninLogs | take 5` ou `DeviceInfo | take 5`), une requête volumineuse (10 000+ lignes), une requête en erreur (table inexistante), puis une requête depuis un deuxième onglet d'éditeur.
2. Repérer dans la console le groupe `[EP-LOG]` correspondant ; si rien n'apparaît, élargir `KEYWORDS`, puis vérifier dans l'onglet Réseau si la requête passe par un Worker ou un WebSocket (non vus par ce logger : le noter).
3. Pour le tenant : noter les **noms** des paramètres d'URL et des clés de corps qui portent un identifiant de tenant/workspace, et ce qui change quand on change de tenant dans le même onglet.
4. Pour l'éditeur, dans la console de la bonne frame avec deux onglets ouverts : `monaco.editor.getEditors().map(e => [e.getId(), e.hasTextFocus(), e.getDomNode()?.offsetParent !== null])`.
5. Reporter le tout dans le gabarit, sans aucune valeur réelle (seulement noms de clés, formes et types).

### Gabarit « Format observé » (relevé le 21/10/2026, identifiants remplacés par des variables)

| Élément | Sentinel | Defender |
| --- | --- | --- |
| Frame qui émet la requête | iframe `sandbox-1.reactblade.portal.azure.net`, la même que Monaco et la grille (d'autres iframes `sandbox-<n>` coexistent) | page principale `security.microsoft.com` |
| Transport | XHR | XHR |
| Requête | `POST api.loganalytics.io/v1/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.OperationalInsights/workspaces/{ws}/query[?=&timespan=…]` | `POST security.microsoft.com/apiproxy/hunting/huntingQueryExecutorService/queryExecutor/v1/external?useFanOut=false` |
| Texte KQL | `body.query` (fins de ligne `\n`) | `body.QueryText` (doublé dans `EncodedQueryText`, fins de ligne `\r\n`) |
| Plage de temps | paramètre d'URL `timespan` : durée ISO 8601 pour un préréglage (`PT30M`, `P7D`), intervalle ISO 8601 `<début>/<fin>` pour une plage personnalisée ; **absent** quand la plage est définie dans la requête | `body.StartTime` / `body.EndTime` (ISO 8601) ; `StartTime` = `null` quand la plage est définie dans la requête |
| Limite de lignes | `body.maxRows` = limite d'affichage + 1 (1001 et 500001 observés) | `MaxRecordCount` (`null` observé) ; plafond serveur 100 000 lignes |
| Autres champs du corps | `options.truncationMaxSize`, `workspaceFilters` | `TenantIds`, `selectedWorkspaces`, `QueryOrigin` (`User`) |
| Tenant / workspace | resourceId du workspace dans le chemin de la requête (aussi dans le hash de l'URL de l'iframe) | `tid` de l'URL de la page, toujours présent ; repris dans les en-têtes `Tenant-Id` et `X-tid` |
| Authentification (noms d'en-têtes) | `Authorization: Bearer`, plus `Prefer`, `x-ms-app`, `x-ms-client-request-id`, `x-ms-client-request-info`, `x-ms-user-id` | cookies de session + en-tête anti-CSRF `X-XSRF-TOKEN` (pas d'`Authorization`), plus `Tenant-Id`, `X-tid`, `X-Hunting-Execution-Context`, `m-*`, `X-ClientPage`, `X-ClientPkgVersion`, `Request-Id`, `traceparent` |
| Limite de débit | non observée | en-têtes de réponse `x-rate-limit-limit` (`1m`), `x-rate-limit-remaining`, `x-rate-limit-reset` |
| Colonnes | `tables[]` peut contenir **plusieurs tables** : prendre celle dont `name` = `PrimaryResult` ; `columns[] = {name, type}`, types en minuscules (`string`, `long`, `bool`, `datetime`, `dynamic`) | `Schema[] = {Name, Type, Entity}` ; types .NET (`String`, `Int32`, `Int64`, `SByte`, `DateTime`, `Object`) |
| Type d'entité par colonne | aucun | `Entity` : `Machine`, `Ip`, `Url`, `File` (colonnes de hash), `UserSid`, `UserObjectId`, sinon `null` — voir la table de correspondance plus bas |
| Lignes | `rows[]` = tableaux dans l'ordre des colonnes ; `dynamic` = chaîne JSON ou `null` | `Results[]` = objets `{colonne: valeur}` ; booléens en `0` / `1` ; colonnes `Object` = vrais objets ou tableaux JSON |
| Dates | ISO 8601 UTC (`…Z`, jusqu'à 7 décimales) | ISO 8601 UTC |
| Tables interrogées | `dataSources[].tables` (vide pour une requête sans table, ex. `range`) | `EnhancedQueryStats.DataSources[].Tables` (`ResourceId` = `Xdr` pour les tables Defender) |
| Empreinte de requête | `statistics.query.queryHash` | `EnhancedQueryStats.Statistics.QueryHash` |
| Visualisation | `render.visualization` | `ChartVisualization.ChartType` |
| Erreur | HTTP 400 ; `error.code`, `error.message`, puis `error.innererror` imbriqué (`code`, `message`) : le message le plus profond est le plus utile | HTTP 400 ; `ErrorCode`, `ErrorMessage`, `RecommendedAction`, `Line`, `Position` |
| Troncature | pas de clé dédiée : tronqué si `rows.length` ≥ `maxRows` − 1 (déduit du +1) | `Warning = {WarningMessage, WarningCode}` ; `WarningCode` = 3 à 100 000 lignes |
| Taille de réponse | en une fois ; 7 Mo et 200 000 lignes testés | en une fois ; 100 000 lignes testées |
| Le patch à `document-start` voit la requête | oui | oui |
| Appels voisins à ignorer | `v2/.../queryHistory` (GET et POST), `userHistoryQueries/Add`, `ResourceGraph`, télémétrie | `huntingService/*` (schéma, favoris, historique), `api/log/Put`, télémétrie |
| Monaco | un seul éditeur pour tous les onglets : le modèle change d'un onglet à l'autre ; `getEditors()[0]` suffit | idem ; changer d'onglet n'envoie aucune requête |
| Bouton Run | `#logs-main-run-button` ; clic par script vérifié ; raccourci Maj+Entrée | `#huntingRunQueryButtonId` (déjà dans `config.ts`) ; clic par script vérifié ; raccourci Maj+Entrée |

**Correspondance `Entity` Defender → type EasyPivot** (relevée sur `DeviceInfo`, `DeviceProcessEvents`, `DeviceNetworkEvents`, `DeviceFileEvents`, `EmailEvents`, `EmailUrlInfo`, `IdentityLogonEvents`, `CloudAppEvents`, `EntraIdSignInEvents`) :

| `Entity` | Type EasyPivot | Exemples de colonnes |
| --- | --- | --- |
| `Machine` | Machine | `DeviceName`, `DeviceId`, `DestinationDeviceName`, `TargetDeviceName` |
| `Ip` | Adresse IP | `RemoteIP`, `LocalIP`, `IPAddress`, `FileOriginIP`, `PublicIP` |
| `Url` | URL | `RemoteUrl`, `Url`, `FileOriginUrl`, `FileOriginReferrerUrl` |
| `File` | Hash | `SHA1`, `SHA256`, `MD5`, `InitiatingProcessSHA256` |
| `UserSid` | Compte (futur type SID, #16) | `AccountSid`, `InitiatingProcessAccountSid`, `RequestAccountSid` |
| `UserObjectId` | Compte (identifiant d'objet) | `AccountObjectId`, `SenderObjectId`, `RecipientObjectId` |
| `null` | → `locations` puis regex | toutes les adresses e-mail (`SenderFromAddress`, `RecipientEmailAddress`), `AccountUpn`, `FileName`, `FolderPath`, `SenderIPv4`, `DestinationIPAddress`, `UrlDomain` |

### Constats et conséquences pour le développement

- **Appels à ignorer** : `queryHistory`, `userHistoryQueries/Add`, `Microsoft.ResourceGraph/resources`, la télémétrie. Les profils filtrent sur le chemin exact : `/workspaces/{ws}/query` (v1) pour Sentinel, `/queryExecutor/v1/external` pour Defender.
- **Pas de relais entre iframes** : sur Sentinel, la requête part de la même iframe que Monaco et la grille. Le script, exécuté dans chaque iframe `reactblade`, ne s'active que dans celle qui contient l'éditeur.
- **Un seul éditeur Monaco** sur Sentinel, partagé par les onglets : même chose sur Defender ; l'issue #13 se réduit à un contrôle de l'existence de l'éditeur.
- **Exécution** : clic sur le bouton par son `id`, avec Maj+Entrée dans l'éditeur en secours.
- **Defender donne le type d'entité** pour une partie des colonnes (`Machine`, `Ip`, `File`, `UserSid`, `UserObjectId`). Il passe en premier dans la détection (#18), mais `locations` et les regex restent nécessaires : `AccountUpn` ou `FileName` n'ont pas d'entité.
- **Les tables qui ont répondu sont dans la réponse** (`dataSources` / `DataSources`) : la Découverte (#29) les lit sans analyser le KQL.
- **Erreurs et troncature** : un `QueryRun` en erreur garde le message le plus profond ; la troncature est signalée dans le résumé et le rapport (Sentinel : comparaison avec `maxRows` ; Defender : `Warning.WarningCode`).
- **Réponses volumineuses** (jusqu'à 200 000 lignes) : analyse différée (`requestIdleCallback`), seul un échantillon est gardé, la réponse brute n'est jamais stockée.
- **Les résultats contiennent des données personnelles et de configuration** (noms, UPN, e-mails, SID, IP, géolocalisation, noms de stratégies d'accès conditionnel). Échantillon limité, purge automatique et export masqué sont obligatoires (nouvelle issue « rétention »).
- **Identifiant de cas** : Sentinel → empreinte du resourceId du workspace en minuscules, lu dans chaque requête ; Defender → empreinte du `tid`. Choix du 21/10 : sur Defender, tout ce qui vient d'un autre `tid` est masqué.
- **Plage « définie dans la requête »** : `timespan` absent (Sentinel), `StartTime` = `null` (Defender) ; le résumé calcule alors la plage depuis les dates des lignes.
- **Rejouer une requête** (niveau 3) suppose de réutiliser les en-têtes d'authentification de la page : les noms sont à relever, les valeurs restent en mémoire et ne sont jamais stockées.

Compléments du 21/10 (second relevé) :

- **Defender seul ou unifié** : sur le tenant testé, `SigninLogs` renvoie HTTP 400 « Failed to resolve table » et `selectedWorkspaces` vaut `{}` (aussi dans l'en-tête `X-Hunting-Execution-Context`) : Defender n'y est pas unifié avec Sentinel. Règle proposée pour #7 : `selectedWorkspaces` vide et aucun `DataSources.ResourceId` autre que `Xdr` → variante `defender` ; les règles sans `defender` dans `platforms` sont alors masquées. Aucun tenant unifié disponible pour confirmer (un tenant par client) : la variante détectée est mémorisée **par tenantKey**, avec réglage manuel possible.
- **En-têtes Sentinel** : `Authorization` (Bearer) et `Prefer: wait=600, ai.include-statistics=true, ai.include-render=true, include-datasources=true`. `dataSources` n'est présent que grâce à `include-datasources` : si la page cesse de l'envoyer, la Découverte retombe sur la grille.
- **En-têtes Defender** : pas de jeton Bearer ; authentification par cookies de session (envoyés automatiquement en same-origin) + `X-XSRF-TOKEN`. Le tenant est répété dans `Tenant-Id` / `X-tid`. Limite de débit annoncée dans `x-rate-limit-*` (fenêtre de 1 min).
- **Niveau 3 (rejouer une requête)** : Sentinel → réutiliser le Bearer de la page ; Defender → réutiliser la valeur `X-XSRF-TOKEN` vue dans `setRequestHeader`. Les deux restent en mémoire le temps de l'appel, jamais écrits. Sur Defender, ne pas lancer de requête de contexte si `x-rate-limit-remaining` est bas. Commit séparé, désactivé par défaut.
- **Décision du 21/10 : capture activée par défaut**, pour la sortie de **toutes** les requêtes de requêtage (pas seulement celles lancées par EasyPivot). La rétention et le masquage (nouvelle issue) deviennent donc indispensables dès la phase 4.

### Informations encore manquantes

Rien ne bloque plus les phases 1 à 4. Restent des points facultatifs :

- [x] Format des échanges, erreurs, troncature, éditeur, exécution, en-têtes, `Entity`, `timespan` : relevés le 21/10
- [ ] Defender unifié avec Sentinel : non vérifiable pour l'instant (un tenant par client, aucun unifié). À refaire dès qu'un client unifié se présente : `SigninLogs | take 1`, puis forme de `selectedWorkspaces` et de `DataSources[].ResourceId`

Pour relever les noms d'en-têtes XHR, ajouter au logger (avant `XMLHttpRequest.prototype.send`) :

```javascript
const setHeader = XMLHttpRequest.prototype.setRequestHeader;
XMLHttpRequest.prototype.setRequestHeader = function (name) {
  (this.__epHeaders ??= []).push(name); // name only, never the value
  return setHeader.apply(this, arguments);
};
// then, in the 'loadend' listener, pass this.__epHeaders instead of null to log()
```

## Workflows existants à modifier

Six workflows changent ; pour chacun : ce qui change, les fichiers touchés et l'ordre des étapes. Les numéros entre crochets renvoient aux issues GitHub.

### W1 Démarrage

**Cible** : la capture réseau est installée avant le code de la page, puis l'UI se monte comme aujourd'hui, avec langue, cas actif et diagnostic.

- `userscript-header.txt` : `@run-at document-start` ; version injectée par Vite depuis `package.json` (`{{VERSION}}`) \[#8\].
- `main.ts` : nouvel ordre → `detectPlatform()` → `installCapture()` si activée (immédiat, avant `DOMContentLoaded`) → attendre `document.body` → `initI18n()` → thème, styles → `initCatalog()` → `initHealth()` → `resolveActiveCase()` → observateurs.
- Observateurs regroupés par `requestAnimationFrame` ; celui du bouton s'arrête une fois le bouton en place et se réarme à la navigation \[#9\].
- Firefox : avec `@grant` ≠ `none`, les fonctions passées à `unsafeWindow.fetch` doivent passer par `exportFunction` ; prévoir un petit utilitaire `toPage(fn)`.

### W2 Pivot depuis une cellule

**Cible** : contexte complet (ligne entière, date exacte), type déduit de la colonne, valeur nettoyée, panneau plus rapide, insertion dans le bon éditeur.

1. `types.ts` : `CellContext` gagne `source: 'capture' | 'grid' | 'dom'`, `entityName?`, `runId?` (résultat capturé d'origine).
2. Lecture de la ligne \[#14\] : chercher d'abord dans le dernier `QueryRun` capturé la ligne dont les cellules visibles correspondent à la ligne DOM ; sinon données AG Grid ; sinon DOM (actuel).
3. Nouveau `core/detection.ts` \[#18\] : `detectForCell(value, column, entityName)` → `locations` du catalogue, puis `entityName` Defender (`context-data-schema` dans `fluent-grid.ts`), puis regex. Sur Defender, le champ Entity du schéma capturé (N1) passe en premier. Corrige aussi #5 et #6.
4. Nouveau `core/normalize.ts` \[#15\] : `normalizeValue(value, type)` (refang, `::ffff:`, port, guillemets, casse des hash), appelé avant détection et remplissage.
5. Découper `ui/pivot-menu.ts` en `ui/panel/` : `context-view.ts`, `params-view.ts` (préréglages ±1 h / ±24 h / ±7 j \[#19\], liens TI \[#20\]), `rules-view.ts` (recherche, clavier, règles récentes \[#17\]), `settings-view.ts`. Faire ce découpage seul, sans changer le comportement, avant d'ajouter des fonctions.
6. `core/editor-bridge.ts` \[#13, #22\] : `getActiveEditor()` (focus → dernier focus suivi par `onDidFocusEditorText` → visible → premier) ; `insertQuery(kql, mode)` avec `append | replace | newTab` ; `PlatformAdapter.runQuery()` clique sur Run si l'option est active.
7. Filtre `platforms` \[#7\] : `getRulesForIndicator(type, variant)` masque ou grise les règles incompatibles.
8. Après injection : enregistrer un `pendingRun { ruleId, snapshotId, kqlHash }` pour relier le prochain résultat capturé au pivot (N1).

### W3 Journal → cas et graphe

**Cible** : le journal plat devient un arbre d'événements rangé dans un cas lié à un tenant.

- `core/investigation.ts` est conservé en phases 1 à 4 (seulement adapté à i18n) puis remplacé en phase 5 par `core/cases.ts`, `core/clients.ts`, `core/tenant.ts` et `core/graph.ts` (détail en N2 et N3).
- `PivotSnapshot` gagne `caseId`, `tenantKey`, `parentSnapshotId?`, `parentRunId?`, `runIds[]`, `note?`, `pinnedRows?`. Le plafond de 30 snapshots devient un plafond par cas (200), la purge suivant la rétention de N1.
- Le sélecteur « Événement » du panneau ne liste que les snapshots du cas actif ; un lien « Voir le cas » ouvre la vue de N3.
- `findOriginRuleId` est conservé pour les snapshots sans `QueryRun` (capture désactivée).
- Migration \[#24\] : détail en N2 (cas « Historique avant cas », ancienne clé conservée jusqu'à confirmation).

### W4 Gestion du catalogue

**Cible** : un catalogue n'est appliqué qu'après validation, et il apporte `locations` et `scenarios`.

- Nouveau `core/catalog-validate.ts` \[#11\] : `formatVersion` dans la plage supportée, placeholders connus, actions et types connus, regex compilables, colonnes présentes dans `locations`. Sortie `{ errors[], warnings[] }`.
- `rules-catalog.ts` : bloquant → catalogue rejeté, précédent conservé ; avertissements → affichés dans les paramètres et le diagnostic.
- `types.ts` : `PivotCatalog` gagne `formatVersion`, `locations: Record<IndicatorId, string[]>` (`Table.Colonne`), `scenarios?`.
- Le contrôle `/_CL$/` est appliqué aussi côté script : toute entrée `_CL` de `locations` est ignorée.

### W5 Build / release

- Plugin Vite : remplacer `{{VERSION}}` dans l'en-tête par `package.json.version` \[#8\].
- Dictionnaires `src/i18n/fr.ts` et `en.ts` inclus dans le bundle \[#10\].
- Pipeline de release : vérifier qu'il exécute `npm run check` (le fichier n'était pas dans l'archive analysée).

### WR Dépôt de règles (MSSentinel-PivotRules)

- `schemas/<Table>.json` pour les tables standard uniquement, sans champ `source` ; CI qui refuse tout fichier `*_CL` \[#30\].
- `indicators/<type>/locations.yml` généré depuis les schémas puis relu à la main, publié dans `pivot-rules.json` \[#31\].
- Vérifier les colonnes suspectes (`IndexName`, doublons `_string` / `_dynamic` / `_datetime`) avec `getschema` avant génération \[#37\] ; ajouter les 6 schémas manquants \[#36\].
- `scenarios/<id>.yml`, règle de découverte générée, modèle d'issue, `formatVersion` \[#32, #34, #35, #38\].

## Nouveaux workflows à créer

Sept workflows nouveaux ; N1 (capture) est celui dont dépendent N3, N4 et N5, et il ne peut être terminé qu'avec le gabarit de l'étape 0.

### N1 Capture des requêtes et résultats \[#21, #22, #23\]

**But** : savoir quelle requête a tourné et ce qu'elle a renvoyé, sans gérer d'authentification. Trois niveaux, livrés dans cet ordre :

1. **Passif** : intercepter `fetch`/XHR de la page, reconnaître les appels de requête, parser la réponse en `QueryRun`.
2. **Insérer + Run** : après injection, cliquer sur Run (option) ; le niveau 1 récupère la réponse.
3. **Requêtes de contexte** (expérimental, désactivé par défaut) : rejouer la requête de la page avec un autre KQL (première/dernière apparition, volume par table). Jetons en mémoire uniquement, limite de débit, bouton d'arrêt.

Fichiers à créer :

- `src/capture/interceptor.ts` : patch générique de `fetch`/XHR, indépendant de la plateforme ; il appelle les profils enregistrés et ne lit jamais les en-têtes.
- `src/capture/profiles/sentinel.ts`, `defender.ts` : implémentations de `CaptureProfile`, **vides tant que le gabarit n'est pas rempli** (elles renvoient `false` dans `match`).
- `src/capture/store.ts` : tampon circulaire de `QueryRun` par cas (50 derniers), échantillon de lignes limité (200 lignes, 2 000 caractères par cellule).
- `src/capture/summary.ts` : résumé pur (nombre de lignes, première/dernière date, 5 valeurs les plus fréquentes par colonne utile, répartition par `Type`/`SourceTable`).
- `src/capture/debug.ts` : mode debug qui affiche la *forme* des échanges (comme le logger de l'étape 0), activable dans les paramètres.

```typescript
export interface CaptureProfile {
  readonly platform: PlatformId;
  /** Is this request a query execution? (url + method + parsed body) */
  match(req: { url: URL; method: string; body: unknown }): boolean;
  extractQuery(body: unknown): { kql: string; timespan?: string; tenantKey?: string } | null;
  parseResponse(body: unknown): ParsedResult | null;
}

export interface ParsedResult {
  readonly columns: readonly { name: string; type: string }[];
  readonly rows: readonly (readonly unknown[])[];
  readonly truncated: boolean;
  readonly error?: string;
}
```

Liaison au pivot : le KQL capturé commence par `// [RULE-ID]` (ajouté par `fillQuery`) ; s'il correspond au `pendingRun` de W2, le `QueryRun` est rattaché au snapshot et à la règle.

**Profils d'après l'étape 0** (détail dans le gabarit) :

- **Sentinel** : `match` = XHR `POST` sur `api.loganalytics.io`, chemin finissant par `/v1/.../workspaces/<ws>/query` (ignorer `v2/.../queryHistory`) ; KQL = `body.query` ; plage = paramètre `timespan` (durée `P…`, intervalle `début/fin`, ou absent) ; résultat = l'entrée de `tables[]` nommée `PrimaryResult` (colonnes + lignes en tableaux) ; tables source = `dataSources[].tables` ; erreur = HTTP 400 + `error.innererror` le plus profond ; tronqué si `rows.length` ≥ `maxRows` − 1 ; clé de tenant = resourceId du workspace extrait du chemin.
- **Defender** : `match` = XHR `POST` sur `/apiproxy/hunting/huntingQueryExecutorService/queryExecutor/v1/external` ; KQL = `body.QueryText` (normaliser `\r\n`) ; plage = `StartTime` / `EndTime` (`StartTime` peut être `null`) ; résultat = `Schema` + `Results` (objets) convertis en colonnes + lignes ; `Entity` conservé par colonne et traduit selon la table de correspondance ; tables source = `EnhancedQueryStats.DataSources[].Tables` ; erreur = HTTP 400 + `ErrorMessage` ; tronqué si `Warning.WarningCode` = 3 ; clé de tenant = `tid` de l'URL de la page ; variante (seul / unifié) déduite de `selectedWorkspaces` et `DataSources`.
- **Commun** : seul le patch XHR est indispensable (garder `fetch` dans l'intercepteur par prudence) ; analyse différée pour les réponses de plusieurs Mo ; aucun relais entre iframes ; capture de toutes les requêtes de requêtage, activée par défaut.
- `ParsedResult` gagne `sourceTables: string[]`, `queryHash?: string`, `warning?: string`, `timeRange?: { start?: string; end?: string; duration?: string }` et, par colonne, `entity?: string`.
- Exécution (#22) : `PlatformAdapter.runQuery()` clique sur `#logs-main-run-button` (Sentinel) ou `#huntingRunQueryButtonId` (Defender), et envoie Maj+Entrée à l'éditeur en secours.

**Déroulé d'une capture** :

1. `interceptor.ts` patche `XMLHttpRequest.prototype.open`, `send` et `setRequestHeader` (et `fetch`) au `document-start`, dans la page Defender et dans chaque iframe `reactblade`.
2. Sur `send`, il passe `{ url, method, body }` aux profils ; aucun profil ne correspond → rien n'est fait (coût négligeable).
3. Sur `loadend`, si un profil correspond : copie de `responseText` et du statut, puis traitement différé avec `requestIdleCallback` (repli `setTimeout(0)`), pour ne jamais ralentir l'affichage des résultats.
4. Le profil produit un `ParsedResult` ; `summary.ts` calcule le résumé ; `store.ts` crée le `QueryRun` dans le cas actif (N2) et le relie au `pendingRun` si l'en-tête `// [RULE-ID]` correspond.
5. Un événement interne `easypivot:run` notifie le panneau, le graphe et la Découverte.

**Garde-fous** : tout le code de capture est dans des `try/catch` qui ne remontent jamais d'erreur à la page ; le patch ne modifie ni la requête ni la réponse ; les en-têtes sont ignorés sauf au niveau 3 (mémoire seulement) ; `capture.enabled = false` désactive le patch au rechargement suivant.

**Rétention et masquage** (nouvelle issue, obligatoire dès la phase 4 puisque la capture est active par défaut sur toutes les requêtes) :

- Échantillon conservé : `capture.maxRowsSample` lignes (défaut 200), cellules tronquées à 2 000 caractères, colonnes `dynamic` / `Object` gardées en chaîne tronquée.
- Requêtes sans lien avec un pivot : seuls le résumé et les colonnes sont gardés par défaut (`capture.keepSampleForManual = false`) ; l'échantillon n'est conservé que pour les requêtes EasyPivot ou si l'utilisateur épingle le résultat.
- Durée : `retention.days` (défaut 30) après le dernier accès au cas ; purge au démarrage et une fois par heure ; un cas clôturé perd ses échantillons après `retention.closedDays` (défaut 7), résumés et notes conservés.
- Plafond global : `retention.maxBytes` (défaut 20 Mo, estimé via la longueur JSON) ; au-delà, suppression des échantillons les plus anciens, puis des `QueryRun` non liés à un pivot.
- Bouton « Purger maintenant » (cas courant / tout) et indicateur de taille dans les paramètres.

**Critères d'acceptation N1** :

- [ ] Une requête lancée à la main sur chaque plateforme apparaît dans le cas actif avec résumé, tables source et statut.
- [ ] Une requête en erreur donne un `QueryRun` `error` avec le message le plus profond.
- [ ] `range x from 1 to 200000 step 1` : pas de gel visible, résultat `truncated` sur Defender, échantillon limité à 200 lignes.
- [ ] Aucune clé de stockage ne contient `Authorization`, `Bearer`, `XSRF` ni cookie.
- [ ] `capture.enabled = false` puis rechargement : plus aucun `QueryRun` créé.
- [ ] Purge : avec `retention.days = 0`, les échantillons disparaissent au rechargement.

### N2 Gestion des cas par tenant \[#24, #25\]

**But** : ne jamais mélanger requêtes et événements de tenants ou de dossiers différents.

**Fichiers** : `src/core/cases.ts` (logique pure), `src/core/clients.ts` (référentiel clients, ci-dessous), `src/core/tenant.ts` (calcul des clés), `src/ui/case-bar.ts` (bandeau du cas actif dans le panneau), `src/ui/panel/settings-view.ts` (sections Cas et Clients).

**Modèle** : un cas = `{ id, name, clientId?, tenantKeys[], createdAt, closedAt?, archivedAt?, tags[], notes, playbook? }` (voir Annexes). Un cas peut couvrir plusieurs clés quand elles appartiennent au même client (workspace Sentinel + tenant Defender).

**Clés de tenant** (`src/core/tenant.ts`, fonctions pures) :

1. `sentinelKey(resourceId)` : resourceId du workspace en minuscules, sans barre finale, extrait du chemin de la requête capturée ou, avant toute requête, du paramètre `resourceId` du hash de l'URL de l'iframe (décodé avec `decodeURIComponent`). Résultat : `sentinel:` + SHA-256 tronqué à 16 caractères hexadécimaux.
2. `defenderKey(tid)` : `tid` de `location.search`, en minuscules. Résultat : `defender:` + SHA-256 tronqué à 16.
3. Le hachage utilise `crypto.subtle.digest` ; la valeur en clair n'est jamais stockée ni exportée, sauf dans le référentiel clients saisi par l'utilisateur (local, voir plus bas).
4. `tid` absent ou resourceId introuvable → clé `unknown`, sonde du diagnostic en « warn », pivot autorisé mais rangé dans un cas « Non attribué ».

**Règle de choix du cas actif** (à chaque chargement et à chaque changement de clé) :

1. Calculer la clé courante.
2. Chercher le client qui déclare cette clé (référentiel). S'il existe : cas ouvert le plus récent de ce client ; aucun → bandeau « Nouveau cas pour \<client> » avec bouton.
3. Sinon, cas ouvert le plus récent portant cette clé ; aucun → bandeau « Tenant inconnu : créer un cas ou rattacher à un client ».
4. Le cas actif est mémorisé par clé dans `shq_cases.activeByKey`.

**Cloisonnement** : le panneau, le journal, le graphe et le rapport n'affichent que les cas dont une clé correspond à la clé courante ou au client courant. Sur Defender, tout ce qui vient d'un autre `tid` est masqué (décision du 21/10). Un pivot est refusé si le cas actif ne couvre pas la clé courante (toast + bouton « Changer de cas »).

**Actions sur un cas** : créer, renommer, rattacher à un client, basculer, clôturer (lecture seule ensuite), archiver (masqué de la liste, purge selon la rétention), supprimer (confirmation).

**Stockage** : index `shq_cases` = `{ version: 1, cases: CaseIndexEntry[], activeByKey: Record<string, string> }` ; contenu `shq_case_<id>` = snapshots, `QueryRun`, notes. Chaque écriture relit l'index avant d'écrire (deux onglets peuvent écrire en même temps).

**Export / import** : JSON `{ format: 'easypivot-case', version: 1, exportedAt, case, snapshots, runs }`, valeurs masquées par défaut (case à cocher « inclure les valeurs »). Les clés exportées sont les empreintes, jamais les identifiants. À l'import : contrôle du format et de la version, refus d'un cas dont les clés ne correspondent ni à la clé courante ni au client courant, sauf confirmation explicite.

**Migration** (premier lancement de la phase 5) : proposer l'export JSON de `shq_pivot_snapshots`, créer le cas « Historique avant cas » avec la clé `unknown`, y copier les snapshots, écrire `shq_migration_v2`, conserver l'ancienne clé jusqu'à ce que l'utilisateur clique « Supprimer l'ancien historique » dans les paramètres.

#### Référentiel clients : rapprocher Sentinel et Defender

Un workspace Sentinel et un tenant Defender d'un même client n'ont aucun identifiant commun dans les URL (relevé du 21/10) : le rapprochement se fait par une table de correspondance saisie une fois par l'utilisateur, stockée localement.

- **Modèle** : `Client = { id, name, defenderTids: string[], sentinelWorkspaces: string[], createdAt, notes? }`. `sentinelWorkspaces` contient les resourceId complets (`/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.OperationalInsights/workspaces/{ws}`), normalisés en minuscules.
- **Stockage** : clé `shq_clients` = `{ version: 1, clients: Client[] }`. C'est la seule donnée où `tid` et resourceId sont en clair, parce que l'utilisateur les saisit pour s'y retrouver. Elle n'est **jamais** incluse dans un export de cas, un rapport, une issue ou le diagnostic.
- **Résolution** : `clients.ts` construit au chargement un index `Map<clé hachée, clientId>` en hachant chaque `tid` et chaque resourceId avec les mêmes fonctions que `tenant.ts`. Une seule fonction publique : `findClientByKey(key): Client | undefined`.
- **Interface** (Paramètres → Clients) : liste des clients ; formulaire nom, `tid` Defender (un ou plusieurs, validation GUID), workspaces Sentinel (un ou plusieurs, validation du motif resourceId) ; boutons « Ajouter le tenant courant » et « Ajouter le workspace courant » qui préremplissent avec la valeur de la page ouverte ; suppression avec confirmation (les cas restent, leur `clientId` est vidé).
- **Saisie assistée** : quand une clé inconnue est détectée, le bandeau du cas propose « Rattacher à un client existant » (liste) ou « Créer un client » (prérempli avec le `tid` ou le workspace courant).
- **Import / export du référentiel** : JSON séparé `{ format: 'easypivot-clients', version: 1, clients }`, avec avertissement « contient des identifiants de tenants » ; utile pour passer d'un navigateur à l'autre.
- **Effet sur le cloisonnement** : deux clés du même client partagent leurs cas ; deux clients différents ne voient jamais les cas l'un de l'autre.
- **Effet sur la variante Defender (#7)** : la variante détectée (seul / unifié) est mémorisée par client quand il existe, sinon par clé.
- **Hors périmètre** : aucune déduction automatique (jeton JWT, colonne `AADTenantId`). Elles pourront s'ajouter plus tard comme simples suggestions dans le bandeau, jamais sans confirmation.

**Critères d'acceptation N2** :

- [ ] Ouvrir Defender sur deux tenants différents : chacun voit uniquement ses cas.
- [ ] Après déclaration d'un client (tenant Defender + workspace Sentinel), un cas créé sur Defender est visible et actif sur Sentinel.
- [ ] Le JSON d'export d'un cas ne contient aucun `tid`, resourceId ni nom de workspace en clair.
- [ ] Supprimer un client ne supprime aucun cas.
- [ ] Pivot refusé avec un message clair si le cas actif appartient à un autre client.

### N3 Graphe d'investigation et rapport \[#26, #27\]

**But** : voir d'où vient chaque événement et produire un rapport sans ressaisie.

**Fichiers** : `src/core/graph.ts`, `src/core/report.ts`, `src/core/redact.ts`, `src/ui/case-view.ts`.

**Graphe** (`graph.ts`, pur) :

- Nœud = snapshot (événement de départ). Champs ajoutés à `PivotSnapshot` : `caseId`, `parentSnapshotId?`, `parentRunId?`, `runIds[]`, `note?`, `pinnedRows?`.
- Arête = pivot : `PivotStep` + `QueryRun` lié. Quand l'utilisateur fait un clic droit dans le résultat d'un pivot, le nouveau snapshot reçoit `parentSnapshotId` = snapshot du pivot et `parentRunId` = `QueryRun` affiché (retrouvé par le dernier `QueryRun` du cas).
- `buildTree(caseId)` renvoie `{ roots: TreeNode[] }` avec, par nœud : valeur, colonne, T0, nombre de pivots, statut du dernier résultat (lignes, tronqué, erreur).
- `timeline(caseId)` renvoie toutes les étapes triées par date pour la chronologie du rapport.

**Vue du cas** (`case-view.ts`) : panneau latéral droit de 420 px, ouvert depuis le bouton EasyPivot (menu « Cas ») ou depuis le panneau Pivot.

- En-tête : nom du cas, client, statut, boutons Rapport, Export, Clôturer.
- Arbre repliable : un clic sur un nœud charge le snapshot dans le panneau Pivot ; icône note ; badge du nombre de lignes du résultat.
- Épingler : dans le panneau Pivot, bouton « Épingler la ligne comme preuve », qui copie la ligne complète capturée (ou visible) dans `pinnedRows` du snapshot.
- Notes : zone de texte par nœud et une note globale du cas, enregistrées à la perte de focus.

**Rapport** (`report.ts`) : généré uniquement sur clic, en Markdown (copier) et HTML autonome (télécharger). Sections, dans l'ordre :

1. Titre, client, dates du cas, auteur (laissé vide, à compléter).
2. Synthèse : note globale du cas.
3. Chronologie : une ligne par pivot (date, règle, valeur, nombre de lignes, tronqué ou erreur).
4. Indicateurs rencontrés : valeurs pivotées, dédupliquées, groupées par type.
5. Preuves : lignes épinglées, en tableau.
6. Notes par nœud.
7. Annexe : texte KQL de chaque requête.

**Masquage** (`redact.ts`, actif par défaut, case à cocher pour désactiver) : IP `203.0.x.x`, e-mail et UPN `j***@d***.tld`, machine `ab***01`, hash conservé (non personnel), SID `S-1-5-21-***-1234`, GUID `xxxxxxxx-…-1234`. Le masquage s'applique aussi au KQL de l'annexe (valeurs des `@"…"`).

**Critères d'acceptation N3** :

- [ ] Pivot depuis le résultat d'un pivot → enfant visible sous son parent.
- [ ] Rapport par défaut : aucune IP, adresse e-mail ou nom de machine complet.
- [ ] Rapport non masqué identique au masqué, valeurs en clair en plus.
- [ ] Rien n'est envoyé sur le réseau pendant la génération (onglet Réseau vide).

### N4 Playbooks guidés \[#28\]

**Fichiers** : `src/core/playbooks.ts`, `src/ui/panel/playbook-view.ts` ; côté dépôt de règles : `scenarios/<id>.yml`.

**Format d'un scénario** (publié dans `pivot-rules.json`, clé `scenarios`) :

```yaml
id: S1
name: Connexion suspecte
description: Qualifier une connexion Entra ID inhabituelle
indicator: ip
steps:
  - ruleId: IP-S1          # activité de l'IP
  - ruleId: IP-P2          # comptes vus sur l'IP
    carry: account         # type de valeur proposé pour l'étape suivante
  - ruleId: ACC-T1         # chronologie du compte
```

**Fonctionnement** :

1. Le panneau affiche « Démarrer un playbook » quand au moins un scénario existe pour le type sélectionné.
2. Démarrer enregistre `case.playbook = { id, step: 0, done: [], values: {} }`.
3. La règle de l'étape courante est mise en avant en tête de liste (badge « Étape n/N »).
4. Lancer cette règle marque l'étape comme faite et avance ; « Passer » avance sans lancer ; « Arrêter » efface `case.playbook`.
5. Si l'étape a un `carry` et qu'un `QueryRun` lié existe, `playbooks.ts` propose jusqu'à 10 valeurs de ce type, extraites des colonnes du résultat reconnues par `Entity`, `locations` puis regex, triées par fréquence ; un clic remplit le champ Valeur.
6. La progression survit au rechargement (stockée dans le cas).

**Validation** (#11) : un scénario dont une `ruleId` n'existe pas dans le catalogue est ignoré avec un avertissement.

**Critères d'acceptation N4** :

- [ ] Un playbook de 3 étapes se déroule jusqu'au bout et reprend après rechargement.
- [ ] Les valeurs proposées pour `carry` viennent du résultat de l'étape précédente.

### N5 Découverte → issue de couverture \[#29\]

**Fichiers** : `src/core/coverage.ts`, `src/ui/panel/coverage-view.ts` ; côté dépôt de règles : règle `DISC-1` générée et `.github/ISSUE_TEMPLATE/missing-source.yml`.

**Règle de découverte** (générée au build du dépôt de règles depuis `locations`, une variante par type d'indicateur) : un `union isfuzzy=true` de blocs `Table | where TimeGenerated between (StartTime .. EndTime) | where Colonne has Value | summarize Hits = count() by Table = "Table", Column = "Colonne"`, puis `| summarize Hits = sum(Hits) by Table, Column`. Fenêtre par défaut 24 h. Aucune table `_CL`.

**Déroulé** :

1. L'utilisateur lance `DISC-1` depuis le panneau (section Statistics).
2. Le résultat est lu via le `QueryRun` (colonnes `Table`, `Column`) ; en secours, depuis la grille.
3. `coverage.ts` retire les tables `_CL` (`/_CL$/i`), puis compare chaque paire au catalogue : tables présentes dans `tables` des règles de ce type, et paires présentes dans `locations`.
4. Deux listes : « table non couverte par les règles » et « colonne absente de `locations` ».
5. Pour chaque écart, bouton « Proposer » : construction de l'URL `https://github.com/arthubhub/MSSentinel-PivotRules/issues/new?template=missing-source.yml&title=...&indicator=...&table=...&column=...&platform=...` (paramètres encodés, URL < 8 000 caractères).
6. Aperçu obligatoire du titre et du corps ; ouverture dans un nouvel onglet uniquement après clic ; l'utilisateur soumet avec son compte GitHub.
7. La paire est ajoutée à `shq_coverage_reported` et n'est plus proposée.

**Contenu autorisé dans l'issue** : type d'indicateur, table, colonne, plateforme, version du catalogue. **Interdit** : valeur, nombre de lignes, tenant, workspace, client, nom de cas. `coverage.ts` construit l'URL à partir d'une liste blanche de champs et refuse toute table `_CL`.

**Critères d'acceptation N5** :

- [ ] L'URL générée ne contient que les 5 champs autorisés.
- [ ] Une table `_CL` dans le résultat n'apparaît nulle part dans les écarts.
- [ ] Un écart déjà proposé n'est plus listé.

### N6 Diagnostic de santé \[#12\]

**Fichiers** : `src/core/health.ts`, sondes déclarées dans chaque adaptateur (`healthProbes`), `src/ui/panel/health-view.ts`.

**Sondes** (chacune renvoie `ok`, `warn` ou `fail` avec un message court, sans aucune donnée) :

| Sonde | Sentinel | Defender | `fail` si |
| --- | --- | --- | --- |
| Page de requêtage | `#DiscoverWrapper` | `#huntingRunQueryButtonId` | absent |
| Éditeur | `monaco.editor.getEditors().length === 1` | idem | 0 éditeur (`warn` si plus d'un) |
| Grille de résultats | `.logs-results-grid .ag-root` | `[role=row].ms-DetailsRow` | absente après une requête réussie |
| Menu de cellule | entrée Pivot ajoutée au dernier clic droit | idem | menu vu sans entrée |
| Bouton Run | `#logs-main-run-button` | `#huntingRunQueryButtonId` | absent |
| Emplacement du bouton | `[data-logs-query-controls-bar]` | parent de `#Join_Queries_Bubble_…` | absent |
| Capture | au moins un `QueryRun` depuis le chargement si une requête a été vue | idem | requête vue mais non analysée |
| Clé de tenant | resourceId trouvé | `tid` trouvé | `warn` si absent |
| Catalogue | rapport de #11 sans erreur bloquante | idem | erreur bloquante |
| Stockage | taille sous `retention.maxBytes` | idem | `warn` au-delà de 80 % |

**Exécution** : au démarrage (5 s après l'injection, silencieux), après chaque requête capturée (sondes Capture et Grille), et à la demande. Un `fail` ajoute une pastille rouge sur le bouton EasyPivot.

**« Copier le diagnostic »** : texte avec version du script, plateforme, variante, navigateur, version du catalogue, état de chaque sonde et avertissements du catalogue. Jamais de valeur, de clé de tenant, de nom de client ni de requête.

### N7 Liens Threat Intel \[#20\]

**Fichiers** : `src/core/ti-links.ts`, rendu dans `src/ui/panel/params-view.ts`.

- **Fournisseurs livrés** (tous désactivés par défaut) : VirusTotal (IP, domaine, URL, hash), AbuseIPDB (IP), urlscan.io (domaine, URL), Shodan (IP). Modèle : `{ id, label, templates: Partial<Record<IndicatorId, string>> }`, avec `{value}` remplacé par `encodeURIComponent(value)` ; pour les URL, VirusTotal attend l'identifiant base64url de l'URL, calculé localement.
- **Fournisseurs personnalisés** : ajout d'un modèle d'URL `https://…{value}…` par type dans les paramètres ; seules les URL `https://` sont acceptées.
- **Activation** : case par fournisseur ; la première activation affiche « La valeur sera envoyée à un service externe quand tu cliqueras sur le lien ».
- **Affichage** : sous le champ Valeur, liens pour le type sélectionné uniquement ; `target="_blank"` et `rel="noopener noreferrer"`.
- **Jamais automatique** : aucune requête vers ces services sans clic ; pas de préchargement, pas d'aperçu.
- **Valeur utilisée** : la valeur normalisée (#15), pas la valeur défangée.

## Plan par phases

Les phases 1 à 4 peuvent démarrer : le cas nominal de la capture est connu. L'étape 0 est terminée : formats, erreurs, troncature, éditeur et exécution sont relevés sur les deux plateformes. Les phases 5 et 6 attendent la phase 4. Une phase = une branche, un ou plusieurs commits, une vérification manuelle.

&#91;embedded content: dépendances entre phases · 6 phases, 1 condition\]

La phase 6 a besoin à la fois des données de règles (phase 2) et des cas (phase 5) ; tout ce qui passe par la capture attend le gabarit de l'étape 0.

| Phase | Dépôt | Issues | Prérequis | Livrable |
| --- | --- | --- | --- | --- |
| 1 Fondations | EasyPivot | #4–#13 + découpage du panneau | aucun | Bugs corrigés, i18n, validation catalogue, diagnostic, bon éditeur |
| 2 Données des règles | PivotRules | #30, #31, #33, #36–#39 | schémas standard | `schemas/`, `locations`, `formatVersion`, nouvelles règles |
| 3 Détection et panneau | EasyPivot | #15–#20 | phases 1 et 2 | Type par colonne, normalisation, recherche, préréglages, liens TI |
| 4 Capture | EasyPivot | #21, #22, #14, puis #23 | étape 0 terminée | `QueryRun`, insertion + Run, ligne complète |
| 5 Cas et graphe | EasyPivot | #24–#27 | phase 4 + tenant identifié | Cas par tenant, migration, arbre, rapport |
| 6 Playbooks et découverte | les deux | #32, #34, #35, #28, #29 | phases 2 et 5 | Scénarios guidés, issue de couverture |
| Docs | les deux | #40–#43 | au fil des phases | READMEs, confidentialité, format du catalogue |

### Prompts à donner à Claude Code

Phase 1 :

```text
Lis CLAUDE.md et docs/PLAN-DEV.md. Travaille uniquement sur la phase 1.
Crée la branche phase-1. Ordre : (a) découpe ui/pivot-menu.ts en ui/panel/* sans changer le comportement,
puis npm run check ; (b) mets en place src/i18n avec t() et migre toutes les chaînes existantes (fr + en) ;
(c) corrige les bugs #4 à #9 décrits dans W1/W2 ; (d) ajoute core/catalog-validate.ts (W4) ;
(e) ajoute core/health.ts et les sondes des adaptateurs (N6) ; (f) getActiveEditor() dans editor-bridge.ts.
Un commit par point. Après chaque commit, liste ce que je dois vérifier à la main.
```

Phase 2 (dans le dépôt de règles, avec les schémas standard copiés dans `schemas-import/`) :

```text
Lis docs/PLAN-DEV.md section WR. Importe schemas-import/*.json dans schemas/ en excluant tout fichier
dont la table finit par _CL et en supprimant le champ source. Ajoute un check CI qui refuse *_CL.
Génère indicators/<type>/locations.yml à partir des noms de colonnes (gère les suffixes _s, _d, _t)
et produis un rapport des correspondances incertaines pour relecture humaine ; ne publie rien sans ma relecture.
Ajoute formatVersion au catalogue généré.
```

Phase 3 :

```text
Phase 3 de docs/PLAN-DEV.md. Implémente core/detection.ts (locations > entityName Defender > regex),
core/normalize.ts, puis les vues du panneau : recherche + clavier + règles récentes, préréglages de fenêtre,
liens TI désactivés par défaut (N7). Toutes les chaînes via t().
```

Phase 4 (peut démarrer : formats, erreurs, troncature et boutons Run relevés) :

```text
Phase 4 de docs/PLAN-DEV.md. Les formats sont dans « Gabarit Format observé » et « Profils d'après l'étape 0 » (N1).
Ordre, un commit par point :
(a) src/capture/interceptor.ts (XHR open/send/setRequestHeader + fetch, try/catch partout, aucune modification
    de la requête ni de la réponse) et passage du script en @run-at document-start ;
(b) profils sentinel.ts et defender.ts exactement selon N1 (PrimaryResult, Schema/Results, erreurs, troncature,
    timespan, Entity, sourceTables), avec ENTITY_TO_INDICATOR des annexes ;
(c) store.ts, summary.ts, rétention et purge (N1, paramètres retention.*), stockage provisoire shq_runs_<tenantKey> ;
(d) core/tenant.ts (clés hachées, N2) ;
(e) lecture de la ligne complète depuis le QueryRun (#14) et détection par Entity (#18) ;
(f) insertQuery(mode) et runQuery() par les ids de boutons, Maj+Entrée en secours (#22) ;
(g) sondes Capture et Clé de tenant du diagnostic.
Ne stocke jamais d'en-tête, de jeton ni de cookie. Le niveau 3 (#23) n'est pas dans cette phase.
```

Phase 5 :

```text
Phase 5 de docs/PLAN-DEV.md. Ordre, un commit par point :
(a) core/clients.ts + section Paramètres → Clients (référentiel manuel tid / workspaces, N2) ;
(b) core/cases.ts : modèle Case, règle de choix du cas actif, cloisonnement, bandeau case-bar.ts ;
(c) migration des snapshots et des shq_runs_* vers les cas, avec export préalable et ancienne clé conservée ;
(d) export / import de cas (masqué par défaut) et export / import séparé du référentiel clients ;
(e) core/graph.ts + ui/case-view.ts (arbre, notes, épinglage) ;
(f) core/redact.ts + core/report.ts (Markdown et HTML, sections de N3).
Vérifie à chaque étape les critères d'acceptation de N2 et N3.
```

Phase 6 :

```text
Phase 6. Dans le dépôt de règles : scenarios/*.yml, règle de découverte générée depuis locations, modèle
d'issue missing-source.yml. Dans EasyPivot : core/playbooks.ts (N4) et core/coverage.ts (N5) ; l'URL d'issue
ne contient que type, table, colonne, plateforme, et exclut toute table _CL.
```

## Vérification manuelle

À dérouler sur Sentinel et sur Defender après chaque phase, avec `dist/sentinel-easypivot.user.js` installé dans Tampermonkey (l'ancienne version désactivée).

Toujours :

- [ ] `npm run check` passe sans erreur
- [ ] Clic droit sur une cellule → entrée « Pivot » présente, panneau ouvert, requête injectée et exécutable
- [ ] Bouton EasyPivot présent après navigation aller-retour dans le portail
- [ ] Aucune erreur EasyPivot dans la console

Phase 1 :

- [ ] Interface en anglais quand le navigateur est en anglais, bascule dans les paramètres
- [ ] Copie presse-papier refusée → toast d'erreur (tester en retirant la permission)
- [ ] Une cellule `4624` ou `Success` ne propose plus « Machine » ; un GUID de `CorrelationId` n'est plus « Application »
- [ ] Sur Defender seul, les règles Sentinel-only sont masquées ou grisées
- [ ] Catalogue volontairement cassé (placeholder inconnu) → avertissement visible, catalogue précédent conservé
- [ ] Diagnostic : toutes les sondes « ok » ; « Copier le diagnostic » ne contient aucune valeur
- [ ] Deux onglets d'éditeur : la requête arrive dans celui qui a le focus

Phase 3 :

- [ ] `hxxp://exemple[.]com` est normalisé ; `1.2.3.4:443` donne `1.2.3.4`
- [ ] Une colonne `RemoteIP` présélectionne IP, `AccountUpn` présélectionne Compte
- [ ] Recherche, flèches, Entrée, Échap fonctionnent ; préréglages remplissent Avant/Après
- [ ] Liens TI absents tant qu'aucun fournisseur n'est activé

Phase 4 :

- [ ] Requête lancée à la main → `QueryRun` visible avec résumé
- [ ] Pivot + Run auto → résultat rattaché à la bonne règle
- [ ] Colonne hors écran : T0 et machine quand même renseignés
- [ ] Inspection du stockage Tampermonkey : aucune trace de `Authorization`, cookie ou jeton

Phase 5 :

- [ ] Migration : export proposé, cas « Historique avant cas » créé, ancienne clé conservée
- [ ] Changement de tenant Defender → changement de cas, aucun cas d'un autre `tid` visible
- [ ] Client déclaré (tenant Defender + workspace Sentinel) → même cas actif sur les deux portails
- [ ] Export du référentiel clients : avertissement affiché ; export de cas : aucun `tid` ni resourceId
- [ ] Rapport : valeurs masquées par défaut, arbre et notes présents
- [ ] Export puis import d'un cas sur un autre navigateur

Phase 6 :

- [ ] Un playbook avance étape par étape et reprend après rechargement
- [ ] Découverte → aperçu d'issue sans valeur, sans tenant, sans table `_CL`
- [ ] Un écart déjà signalé n'est plus proposé

## Annexes

Référence pour Claude Code : types à ajouter dans `src/types.ts`, clés de stockage et paramètres. Les noms sont des propositions, à garder cohérents d'une phase à l'autre.

### Modèles de données

```typescript
export type PlatformVariant = 'sentinel' | 'defender' | 'defender-unified';

/** 'sentinel:<hash16>' | 'defender:<hash16>' | 'unknown' */
export type TenantKey = string;

export interface ParsedColumn {
  readonly name: string;
  readonly type: string;            // as returned by the platform
  readonly entity?: string;         // Defender Schema[].Entity
}

export interface ParsedResult {
  readonly columns: readonly ParsedColumn[];
  readonly rows: readonly (readonly unknown[])[];
  readonly truncated: boolean;
  readonly error?: string;          // deepest error message
  readonly warning?: string;        // Defender Warning.WarningMessage
  readonly sourceTables: readonly string[];
  readonly queryHash?: string;
  readonly timeRange?: { start?: string; end?: string; duration?: string };
}

export interface QueryRun {
  readonly id: string;
  readonly caseId: string;
  readonly tenantKey: TenantKey;
  readonly platform: PlatformId;
  readonly kqlHash: string;          // SHA-256 of the normalized KQL text
  readonly kqlPreview: string;       // first 300 chars
  readonly ruleId?: string;          // from the `// [RULE-ID]` header
  readonly snapshotId?: string;      // pivot that produced it
  readonly startedAt: number;
  readonly durationMs: number;
  readonly status: 'ok' | 'error' | 'truncated';
  readonly error?: string;
  readonly rowCount: number;
  readonly columns: readonly ParsedColumn[];
  readonly sourceTables: readonly string[];
  readonly summary: RunSummary;
  readonly rowsSample?: readonly (readonly unknown[])[]; // capped, see retention
  readonly lastAccessAt: number;
}

export interface RunSummary {
  readonly firstSeen?: string;
  readonly lastSeen?: string;
  readonly bySource?: Readonly<Record<string, number>>;
  readonly topValues?: Readonly<Record<string, readonly [string, number][]>>;
}

export interface Client {
  readonly id: string;
  readonly name: string;
  readonly defenderTids: readonly string[];       // clear text, local only
  readonly sentinelWorkspaces: readonly string[]; // full resourceIds, lowercase
  readonly createdAt: number;
  readonly notes?: string;
  readonly variant?: PlatformVariant;             // detected Defender variant
}

export interface Case {
  readonly id: string;
  readonly name: string;
  readonly clientId?: string;
  readonly tenantKeys: readonly TenantKey[];
  readonly createdAt: number;
  readonly lastAccessAt: number;
  readonly closedAt?: number;
  readonly archivedAt?: number;
  readonly tags: readonly string[];
  readonly notes: string;
  readonly playbook?: { id: string; step: number; done: readonly string[]; values: Readonly<Record<string, string>> };
}

// PivotSnapshot (existing) gains:
//   caseId, tenantKey, parentSnapshotId?, parentRunId?, runIds: string[], note?, pinnedRows?: unknown[][]

export interface Scenario {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly indicator: IndicatorId;
  readonly steps: readonly { ruleId: string; carry?: IndicatorId }[];
}

/** Defender Entity -> EasyPivot indicator */
export const ENTITY_TO_INDICATOR: Readonly<Record<string, IndicatorId>> = {
  Machine: 'device',
  Ip: 'ip',
  Url: 'url',
  File: 'hash',
  UserSid: 'account',      // 'sid' once #16 adds the type
  UserObjectId: 'account',
};
```

### Clés de stockage Tampermonkey

| Clé | Contenu | Phase | Exportable |
| --- | --- | --- | --- |
| `shq_pivot_rules_url` | URL du catalogue (existant) | — | non |
| `shq_pivot_rules_cache` | Catalogue normalisé + date (existant) | — | non |
| `shq_pivot_snapshots` | Ancien journal, conservé jusqu'à migration confirmée | 5 | non |
| `shq_settings` | Paramètres (ci-dessous) | 1 | non |
| `shq_recent_rules` | 10 dernières règles lancées | 3 | non |
| `shq_runs_<tenantKey>` | `QueryRun` avant l'arrivée des cas (phase 4), migrés en phase 5 | 4 | non |
| `shq_clients` | Référentiel clients, `tid` et resourceId en clair | 5 | export séparé, avec avertissement |
| `shq_cases` | Index des cas + cas actif par clé | 5 | non |
| `shq_case_<id>` | Snapshots, `QueryRun`, notes, preuves d'un cas | 5 | oui (export de cas, masqué par défaut) |
| `shq_migration_v2` | Date de migration confirmée | 5 | non |
| `shq_coverage_reported` | Paires type/table/colonne déjà proposées | 6 | non |

### Paramètres (`shq_settings`)

| Paramètre | Valeurs | Défaut |
| --- | --- | --- |
| `lang` | `auto`, `fr`, `en` | `auto` |
| `insertMode` | `append`, `replace`, `newTab` | `append` |
| `autoRun` | booléen | `false` |
| `capture.enabled` | booléen | `true` (toutes les requêtes, décision du 21/10) |
| `capture.keepSampleForManual` | booléen : garder l'échantillon des requêtes non lancées par EasyPivot | `false` |
| `capture.maxRowsSample` | entier | `200` |
| `capture.debug` | booléen | `false` |
| `capture.contextQueries` | booléen (niveau 3) | `false` |
| `retention.days` | jours après le dernier accès au cas | `30` |
| `retention.closedDays` | jours avant purge des échantillons d'un cas clôturé | `7` |
| `retention.maxBytes` | plafond global | `20000000` |
| `report.redact` | booléen | `true` |
| `ti.providers` | liste d'identifiants activés | vide |
| `ti.custom` | fournisseurs personnalisés | vide |
| `platformVariant` | `auto` ou une `PlatformVariant` (prioritaire sur la variante du client) | `auto` |

### Point ouvert

Defender seul ou unifié : sur le tenant testé, Defender ne résout pas les tables Sentinel (variante defender). Détection proposée : selectedWorkspaces vide et DataSources limité à Xdr. Le cas unifié reste à confirmer (aucun client unifié pour l'instant) ; la variante détectée est mémorisée par tenantKey. En attendant, `platformVariant` se règle à la main.
