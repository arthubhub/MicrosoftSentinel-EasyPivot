/**
 * French dictionary — reference wording, validated by the user.
 * Keep these strings byte-for-byte: they are the source of truth, `en.ts`
 * is the translation.
 */
export const fr = {
  // ── Common ──
  'common.pivot': 'Pivot',
  'common.close': 'Fermer',
  'common.default': 'défaut',

  // ── Inline button ──
  'button.title': 'EasyPivot : historique des événements, pivot manuel et paramètres',

  // ── Context menu (grid right-click) ──
  'menu.pivotWithType': 'Pivot · {label}',

  // ── Panel chrome ──
  'panel.settingsTitle': 'Paramètres',
  'panel.closeTitle': 'Fermer (Échap)',

  // ── Panel · context (investigation journal) ──
  'panel.context.eventLabel': 'Événement',
  'panel.context.restoreLabel': '↶ Requête source',
  'panel.context.currentClick': 'Clic actuel · {column} = {value}',
  'panel.context.chooseEvent': '— Choisir un événement —',
  'panel.context.noEvent': 'Aucun événement enregistré',
  'panel.context.sourceNotSaved': 'Requête source non enregistrée (éditeur vide ou trop volumineux)',
  'panel.context.restoreHint':
    "Remet dans l'éditeur la requête qui avait produit cet événement (Ctrl+Z pour annuler)",
  'panel.context.fieldsLabel': 'Champs de la ligne',
  'panel.context.pivotsLaunched': 'Pivots lancés : ',
  'panel.context.originSuffix': ' · depuis {id}',
  'panel.context.stepsSuffix': ' · {n} pivot{s}',

  // ── Panel · params ──
  'panel.params.valueLabel': 'Valeur',
  'panel.params.valuePlaceholder': 'Valeur à pivoter',
  'panel.params.t0Label': 'T0 (UTC)',
  'panel.params.t0Placeholder': 'vide = now()',
  'panel.params.t0ReadFromGrid': 'Lu dans la grille : {raw}',
  'panel.params.t0NotFound': 'Heure de la ligne introuvable',
  'panel.params.beforeLabel': 'Avant',
  'panel.params.afterLabel': 'Après',
  'panel.params.windowHint': 'Minutes, ou 30m, 24h, 7d. Vide = fenêtre par défaut',
  'panel.params.hostLabel': 'Machine (règles Processus / Hash)',
  'panel.params.hostPlaceholder': 'vide = toutes',
  'panel.params.typeMatches': 'La valeur correspond à ce type',
  'panel.params.typeMismatch': 'La valeur ne correspond pas à ce type, pivot possible quand même',

  // ── Panel · rules ──
  'panel.rules.injectTitle': "Injecter la requête dans l'éditeur",
  'panel.rules.ranBadge': '✓ lancée',
  'panel.rules.ranTitle': 'Déjà lancée sur cette valeur depuis cet événement',
  'panel.rules.detailsTitle': 'Détails',
  'panel.rules.readingDecisive': 'Tranche : ',
  'panel.rules.readingContext': 'Oriente : ',
  'panel.rules.readingNoise': 'Bruit : ',
  'panel.rules.noRules': 'Aucune règle pour ce type',
  'panel.rules.hiddenForPlatform': '{n} règle{s} masquée{s} pour cette plateforme',

  // ── Panel · settings ──
  'settings.ageNow': "à l'instant",
  'settings.ageMinutes': 'il y a {n} min',
  'settings.ageHours': 'il y a {n} h',
  'settings.ageDays': 'il y a {n} j',
  'settings.rulesUrlLabel': 'URL du catalogue de règles',
  'settings.saveReload': 'Enregistrer et recharger',
  'settings.defaultUrl': 'URL par défaut',
  'settings.clearHistory': "Effacer l'historique",
  'settings.sourceBundled': 'intégré au script',
  'settings.sourceCache': 'cache ({age})',
  'settings.sourceRemote': 'téléchargé ({age})',
  'settings.catalogStatus': 'Catalogue v{version} · {count} règles · {source}',
  'settings.downloadFailed': 'Échec du téléchargement : {error}',
  'settings.downloading': 'Téléchargement…',
  'settings.catalogWarningsLabel': 'Avertissements du catalogue :',

  // ── Toasts ──
  'notify.emptyValue': 'Valeur vide',
  'notify.invalidWindow': 'Fenêtre invalide : minutes, ou 30m, 24h, 7d',
  'notify.invalidT0': 'T0 invalide : format ISO attendu (2026-10-08T09:21:14Z)',
  'notify.timeSelectorHint': ' Sélecteur de temps : « Set in query »',
  'notify.ruleInjected': '{id} injectée.{hint}',
  'notify.ruleCopied': '{id} copiée dans le presse-papier',
  'notify.injectFailed': "Impossible d'injecter la requête",
  'notify.clipboardDenied': 'Accès au presse-papier refusé, requête non copiée',
  'notify.sourceRestored': 'Requête source restaurée (Ctrl+Z pour annuler)',
  'notify.editorNotFound': 'Éditeur introuvable',
  'notify.catalogDownloadFailed': 'Catalogue non téléchargé, version précédente conservée',
  'notify.catalogLoaded': 'Catalogue v{version} chargé ({count} règles)',
  'notify.historyCleared': 'Historique des événements effacé',
  'notify.diagnosticsCopied': 'Diagnostic copié dans le presse-papier',
  'notify.diagnosticsCopyFailed': 'Accès au presse-papier refusé, diagnostic non copié',

  // ── Catalog errors (surfaced in the settings status line) ──
  'error.invalidJson': 'JSON invalide',
  'error.networkError': 'erreur réseau',
  'error.timeout': 'délai dépassé',
  'error.unexpectedCatalogFormat': 'format de catalogue inattendu',

  // ── Catalog validation (#11) ──
  'error.catalogRejected': 'catalogue rejeté : {reason}',
  'validate.formatVersionUnsupported':
    'formatVersion {version} non pris en charge (attendu {min} à {max})',
  'validate.formatVersionInvalid': 'formatVersion illisible : « {version} »',
  'validate.unknownPlaceholder': 'règle {id} : placeholder inconnu « {name} »',
  'validate.unknownIndicator': "règle {id} : type d'indicateur inconnu « {name} »",
  'validate.noKnownIndicator': "règle {id} : aucun type d'indicateur connu, règle inaccessible",
  'validate.unknownAction': 'règle {id} : action inconnue « {name} »',
  'validate.badPattern': 'type {type} : expression régulière n°{n} non compilable',
  'validate.noPatterns':
    'type {type} : aucune expression régulière valide, détection automatique indisponible',
  'validate.unknownLocationType': 'locations : type inconnu « {type} » ignoré',
  'validate.badLocation':
    'locations {type} : entrée « {entry} » ignorée (format Table.Colonne attendu)',
  'validate.locationsCustomTable':
    'locations {type} : {n} entrée{s} de table personnalisée ignorée{s}',
  'validate.noRules': 'aucune règle utilisable dans le catalogue',

  // ── Health diagnostics (N6, #12) ──
  'health.title': 'Diagnostic de santé',
  'health.refresh': 'Rafraîchir',
  'health.copy': 'Copier le diagnostic',
  'health.notRun': 'Diagnostic non encore exécuté',
  'health.diag.platform': 'Plateforme',
  'health.diag.browser': 'Navigateur',
  'health.diag.catalog': 'Catalogue',
  'health.probe.queryPage': 'Page de requêtage',
  'health.probe.editor': 'Éditeur',
  'health.probe.resultsGrid': 'Grille de résultats',
  'health.probe.cellMenu': 'Menu de cellule',
  'health.probe.runButton': 'Bouton Exécuter',
  'health.probe.buttonAnchor': 'Emplacement du bouton',
  'health.probe.catalog': 'Catalogue',
  'health.probe.storage': 'Stockage',
  'health.probe.capture': 'Capture',
  'health.probe.tenantKey': 'Clé de tenant',
  'health.state.ok': 'OK',
  'health.state.warn': 'Avertissement',
  'health.state.fail': 'Échec',
  'health.state.pending': 'Indisponible',
  'health.msg.probeError': 'sonde en erreur',
  'health.landmarkFound': 'élément détecté',
  'health.landmarkMissing': 'élément introuvable',
  'health.editor.none': 'aucun éditeur Monaco détecté',
  'health.editor.one': 'éditeur détecté',
  'health.editor.multiple': 'plusieurs éditeurs détectés',
  'health.grid.ok': 'grille détectée',
  'health.grid.notYet': 'pas encore observée',
  'health.grid.lost': 'grille disparue après une requête',
  'health.menu.ok': 'entrée Pivot présente au dernier clic droit',
  'health.menu.notYet': 'aucun clic droit observé encore',
  'health.menu.missingEntry': 'entrée Pivot absente au dernier clic droit',
  'health.catalog.ok': 'aucun avertissement',
  'health.catalog.warnings': '{n} avertissement{s}',
  'health.catalog.blocked': 'catalogue rejeté (erreur bloquante)',
  'health.storage.ok': '{pct} % utilisé',
  'health.storage.warn': '{pct} % utilisé (seuil 80 % dépassé)',
  'health.storage.fail': 'quota dépassé ({pct} %)',
  'health.pending': 'non disponible (phase 4)',
} as const;

/** Every valid key for `t()`, derived from the French reference dictionary. */
export type MessageKey = keyof typeof fr;
