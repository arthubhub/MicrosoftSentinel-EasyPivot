# Microsoft Sentinel & Defender: EasyPivot

Userscript Tampermonkey pour **pivoter sur les IOC** directement depuis les résultats de **Microsoft Sentinel**.

Clic droit sur une cellule de résultats -> **Pivot** -> choix d'une query (Statistics/Pivot/Timeline) -> la requête KQL, déjà paramétrée avec la valeur et la date est injectée dans l'éditeur.

## Tutorial

### Select an Indicator

<img width="796" height="540" alt="Indicator Selection" src="https://github.com/user-attachments/assets/ba020b7e-89df-4165-b091-7056e1ba36e2" />


### Pivot on it

| Menu | Result |
| --- | --- |
| <img width="380" height="500" alt="Menu" src="https://github.com/user-attachments/assets/fb7066a7-6540-407c-91d2-c589b87b87c1" /> | <img width="1728" height="408" alt="Result" src="https://github.com/user-attachments/assets/da24c667-5e49-47ca-9b65-0d6711f8aaad" /> |

### Switch on Defender, keep all history and context

<img width="800" height="390" alt="Switch App" src="https://github.com/user-attachments/assets/167e6115-95cd-41c6-b0f5-63cdb6c3c2c1" />


## Contexte d'investigation

EasyPivot enregistre à chaque pivot, un instantané de l'événement:

- la ligne de départ (valeur, colonne, T0, machine, et tous les champs de la ligne présents à l'écran) ;
- le contenu de l'éditeur qui avait produit cette ligne (la requête source) ;
- les règles lancées depuis cet événement.

Depuis le panneau Pivot (clic droit, ou bouton **EasyPivot** dans la barre de commandes) :

- **Événement** : revenir à n'importe quel événement précédent, sans relancer de requête ;
- **Champs de la ligne** : pivoter sur un autre champ de l'événement en un clic (IP, compte, machine...) ;
- **Requête source** : remettre dans l'éditeur la requête initiale (Ctrl+Z pour annuler) ;

## Catalogue de règles

Les règles sont maintenues dans un dépôt séparé : [MSSentinel-PivotRules](https://github.com/arthubhub/MSSentinel-PivotRules) (une règle = un fichier YAML). Par défaut, EasyPivot télécharge :

```
https://github.com/arthubhub/MSSentinel-PivotRules/releases/latest/download/pivot-rules.json
```

Les deux formats publiés par le dépôt de règles sont acceptés :

Le catalogue est mis en cache 12 h et rafraîchi en arrière-plan. L'URL se change dans le panneau Pivot → Paramètres.

## Installation

1. Installer [Tampermonkey](https://www.tampermonkey.net/)
2. Cliquer sur **[Installer le userscript](https://github.com/arthubhub/MicrosoftSentinel-EasyPivot/releases/latest/download/sentinel-easypivot.user.js)**
3. Ouvrir l'Advanced Hunting de Sentinel

## Build

```
npm install
npm run build
```

Sortie : `dist/sentinel-easypivot.user.js`. `npm run check` lance les vérifications puis le build.

## Publication

À chaque merge sur la branche master, une release contenant `sentinel-easypivot.user.js` avec la version est publiée. Lien :

```
https://github.com/arthubhub/MicrosoftSentinel-EasyPivot/releases/latest/download/sentinel-easypivot.user.js
```

## TODO

- **Defender** : Récupérer les champs nécessaires au fonctionnement et l'ajouter (comme pour Sentinel)
- **Extension statistiques des tables** : récupérer des stats sur les IOCs, les comparer avec ceux du repo `MSSentinel-PivotRules`, envoyer une demande d'amélioration si un nouveau chap est détecté. Par exemple on envoie :

```kql
search "VALUE"
| take 100
```

puis on cherche les localisations du champ "VALUE", puis on vérifie si $table."chemin" exist dans MSSentinel-PivotRules->indicators->type->locations.yml

## Crédits

Ce projet est un fork de [MicrosoftSentinel-Userscript](https://github.com/LasCC/MicrosoftSentinel-Userscript) de **LasCC**, sans qui il n'existerait pas : intégration au portail, pont vers l'éditeur Monaco, thème et composants d'interface viennent de son travail.
