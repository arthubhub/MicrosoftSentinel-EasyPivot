# Microsoft Sentinel & Defender: EasyPivot

Userscript Tampermonkey pour **pivoter sur les IOC** (IP, comptes, e-mails, URL, domaines, machines, processus, applications, hashs) directement depuis les résultats de l'Advanced Hunting de **Microsoft Sentinel** (et bientôt **Microsoft Defender**).

Clic droit sur une cellule de résultats → **⇄ Pivot** → choix d'une règle (Statistics, Pivot ou Timeline) → la requête KQL, déjà paramétrée avec la valeur, l'heure de la ligne (T0) et la machine, est injectée dans l'éditeur.

## Fonctionnalités

- Entrée **« ⇄ Pivot · <type> »** ajoutée en tête du menu contextuel de la grille Sentinel
- Détection automatique du type d'indicateur (présélection du plus spécifique), pivot possible sur n'importe quel type
- **T0** lu dans la colonne de temps de la ligne (`TimeGenerated`, `Timestamp`…), avec gestion UTC / heure locale
- **Machine** lue dans la ligne pour les règles Processus et Hash
- Fenêtre avant/après modifiable (`30`, `30m`, `24h`, `7d`), défaut propre à chaque règle
- Si du texte est sélectionné dans la cellule, le pivot porte sur la sélection
- **Contexte d'investigation** (voir plus bas) : on ne perd plus l'événement de départ quand on pivote
- Catalogue de règles **téléchargé et mis en cache** (URL modifiable), avec repli sur le catalogue intégré
- Thème clair / sombre via les variables du portail Azure

Maj + clic droit garde le menu du navigateur (copier, inspecter).

## Contexte d'investigation

Lancer une requête de pivot remplace la grille de résultats : l'événement de départ (le couple valeur × T0, les autres champs de la ligne) disparaît, et il fallait effacer la requête de pivot puis relancer la requête initiale pour pivoter à nouveau.

EasyPivot enregistre désormais, à chaque pivot, un **instantané de l'événement** :

- la ligne de départ (valeur, colonne, T0, machine, et tous les champs de la ligne présents à l'écran) ;
- le contenu de l'éditeur qui avait produit cette ligne (la requête source) ;
- les règles lancées depuis cet événement.

Depuis le panneau Pivot (clic droit, ou bouton **EasyPivot** dans la barre de commandes) :

- **Événement** : revenir à n'importe quel événement précédent, sans relancer de requête ;
- **Champs de la ligne** : pivoter sur un autre champ de la même ligne en un clic (IP, compte, machine…) ;
- **↶ Requête source** : remettre dans l'éditeur la requête initiale (Ctrl+Z pour annuler) ;
- les règles déjà lancées sur la valeur sont marquées **✓ lancée**.

Les 30 derniers événements sont conservés dans le stockage Tampermonkey (local au navigateur).

## Catalogue de règles

Les règles sont maintenues dans un dépôt séparé : [MSSentinel-PivotRules](https://github.com/arthubhub/MSSentinel-PivotRules) (une règle = un fichier YAML, compilée et validée par la CI de ce dépôt). Par défaut, EasyPivot télécharge :

```
https://github.com/arthubhub/MSSentinel-PivotRules/releases/latest/download/pivot-rules.flat.json
```

Les deux formats publiés par le dépôt de règles sont acceptés :

- `pivot-rules.json` (format complet) : utilisé tel quel, variantes Defender comprises ;
- `pivot-rules.flat.json` (`[{ name, category, description, query }]`) : converti à la volée. L'id, l'action, l'indicateur, la fenêtre par défaut, les paramètres et le rendu sont déduits du nom, de la catégorie et de l'en-tête KQL ; les informations absentes du format plat (indicateurs secondaires, `v1`, lecture des résultats) sont reprises de la même règle du catalogue intégré.

Le catalogue est mis en cache 12 h et rafraîchi en arrière-plan. L'URL se change dans le panneau Pivot → ⚙ Paramètres. Si le téléchargement échoue, le dernier catalogue valide (ou celui intégré au script, `rules/pivot-rules.json`, copie du format complet) reste utilisé.

Chaque requête commence par un en-tête de paramètres : une requête non remplie reste du KQL valide. À l'injection, les lignes vides sont retirées (dans l'éditeur Sentinel, une ligne vide sépare deux requêtes) et les lignes de commentaire gardent leurs `{{…}}`.

## Installation

1. Installer [Tampermonkey](https://www.tampermonkey.net/)
2. Cliquer sur **[Installer le userscript](https://github.com/arthubhub/MicrosoftSentinel-EasyPivot/releases/latest/download/sentinel-easypivot.user.js)**
3. Ouvrir l'Advanced Hunting de Sentinel

## Build

```
npm install
npm run build
```

Sortie : `dist/sentinel-easypivot.user.js`. `npm run check` lance le typecheck puis le build.

## Publication

Le workflow `Build & Release` vérifie chaque pull request et chaque push (typecheck + build). À chaque merge sur la branche par défaut, il publie une release contenant `sentinel-easypivot.user.js`, avec la version `<version du package>.<numéro de run>` (Tampermonkey ne met à jour que si `@version` augmente). Lien stable :

```
https://github.com/arthubhub/MicrosoftSentinel-EasyPivot/releases/latest/download/sentinel-easypivot.user.js
```

## Feuille de route

- **Defender** : cartographier la grille de résultats de security.microsoft.com (l'adaptateur et le mode « clic droit → panneau direct » sont déjà prêts)
- **Extension statistiques des tables** : récupérer des stats sur les tables (présence, volumétrie, rétention) pour adapter les règles proposées
- **Extension catalogue** : enrichir et mettre à jour les règles sur le dépôt GitHub depuis l'outil

## Crédits

Ce projet est un fork de [MicrosoftSentinel-Userscript](https://github.com/LasCC/MicrosoftSentinel-Userscript) de **LasCC**, sans qui il n'existerait pas : intégration au portail, pont vers l'éditeur Monaco, thème et composants d'interface viennent de son travail.
