# Comptes, SaaS Turtlzim et connecteurs : étude de faisabilité et feuille de route

Étude du 2026-10-15, à la demande du propriétaire du projet. Elle répond à cinq demandes :

1. S'authentifier sur la version web : e-mail + mot de passe avec code de confirmation par e-mail, ou compte d'un service gratuit (Google, GitHub, etc.).
2. Déployer la version web sur un **hébergement mutualisé OVH**, comme SaaS, avec l'authentification **en option** : sans compte, les notes restent locales ; avec un compte, elles peuvent être sauvegardées sur le SaaS.
3. **Connecteurs** Google Drive, ownCloud, Dropbox, GitHub (et GitLab) pour sauvegarder et récupérer les notes, avec sauvegarde automatique. Les applications natives peuvent aussi se connecter au compte Turtlzim pour voir et modifier les notes du SaaS. Le SaaS est limité à **1 Mo par utilisateur** pour le moment.
4. Après authentification (ou usage d'un connecteur), l'utilisateur choisit de sauvegarder **en clair ou chiffré** ; une **passphrase** est demandée pour chiffrer.
5. Une étude de faisabilité et les étapes pour tout faire aboutir.

Ce qui est **vérifié** (documentation officielle ou code du dépôt) est séparé de ce qui est **supposé** : l'hébergement OVH en particulier n'a pas été essayé, et plusieurs points ne se confirment que par un essai (phase 0).

---

## 1. Verdict en une page

**C'est faisable, avec un seul vrai risque d'architecture : l'hébergement mutualisé.** Il n'exécute que du PHP et du MySQL : le serveur de synchronisation de Turtl (Node + Postgres) ne peut pas y tourner, et il faut écrire une petite API PHP à sa place. Tout le reste (comptes, chiffrement, synchronisation, connecteurs) repose sur des briques éprouvées, et l'essentiel du travail est de la synchronisation fiable, pas de la technique exotique.

| Demande | Faisabilité | Risque | Remarque |
|---|---|---|---|
| E-mail + mot de passe + code par e-mail | Oui | Faible | Quotas d'envoi d'OVH (100 e-mails/h sur « Perso ») et risque de spam à encadrer |
| Connexion Google, GitHub, Microsoft, GitLab | Oui | Faible à moyen | Appels sortants du PHP d'OVH à tester (filtrage) |
| Connexion LinkedIn | Oui | Moyen | Demande une page entreprise LinkedIn et le produit « OpenID Connect » |
| Connexion Facebook | Oui | Moyen à élevé | Vérification de l'application, politique de confidentialité exigée ; à faire en dernier |
| Connexion Apple | Non retenu | — | Programme développeur payant (hors « gratuit ») |
| SaaS sur mutualisé OVH, compte optionnel | Oui, en PHP + MySQL | Moyen | Pas de Node.js sur le mutualisé (forums OVH), pas de WebSocket : synchronisation par interrogation |
| Limite de 1 Mo par utilisateur | Oui | Faible | Techniquement trivial ; l'expérience est le sujet (les images tiennent mal dans 1 Mo) |
| Sauvegarde automatique | Oui | Moyen | La difficulté est le conflit (deux appareils), pas l'envoi |
| Connecteurs Dropbox, Google Drive | Oui | Moyen | OAuth dans le navigateur, CORS accepté |
| Connecteur GitHub / GitLab | Oui | Moyen | Commits groupés ; échange de jeton GitHub impossible sans secret |
| Connecteur ownCloud / Nextcloud | Oui en natif, limité en web | Moyen | WebDAV bloqué par CORS sauf configuration du serveur de l'utilisateur |
| Clair ou chiffré au choix, passphrase | Oui | Moyen | Pas de récupération possible sans clé de secours (zéro connaissance) |
| Applications natives sur le compte Turtlzim | Oui | Moyen | Connexion par navigateur système ; la permission réseau d'Android doit être ajoutée |

**Ordre recommandé :** (1) un essai d'hébergement, (2) comptes par e-mail, (3) synchronisation des carnets en clair vers le SaaS, (4) chiffrement, (5) connexion sociale, (6) connecteurs un par un, (7) applications natives. Un premier jalon utile (comptes + SaaS en clair + sauvegarde automatique) tient en environ 5 à 7 semaines de travail soutenu.

---

## 2. Ce que le projet a déjà (vérifié dans le dépôt)

- **Un seul éditeur web**, réutilisé par le navigateur, le programme desktop (Tauri) et l'application Android (Capacitor).
- **Des stockages interchangeables** derrière une interface `NotebookStore` (mémoire, IndexedDB, coffre chiffré, dossier Zim sur le desktop), avec une suite de tests commune. Un connecteur distant se branche donc comme **un stockage de plus**, sans toucher à l'éditeur.
- **Les carnets chiffrés locaux** : le cœur Turtl en WebAssembly dans un Worker, une passphrase (scrypt 128 Mio), sauvegarde et restauration du coffre en un fichier chiffré. C'est la base du chiffrement « cloud ».
- **La disposition des fichiers Zim** (pages `.txt`, dossier du même nom pour les pièces jointes, `notebook.zim`) est déjà lue et écrite par le desktop. C'est aussi la disposition naturelle d'un dossier Dropbox, Drive, Nextcloud ou d'un dépôt Git : **un même format pour tous les endroits**.
- **Règles de projet à respecter** (CLAUDE.md) : une seule base de code de chiffrement (libsodium, jamais refaite par plateforme) ; la logique de synchronisation va dans le cœur sauf si elle est purement de présentation ; le contenu d'un carnet chiffré ne va « nulle part ailleurs que dans le coffre » (cette phrase devra être **révisée** : du texte chiffré partira vers le SaaS ou un connecteur, jamais du texte en clair pour un carnet chiffré) ; l'application est épinglée par un service worker.

---

## 3. L'hébergement mutualisé OVH

### Ce qui est confirmé

D'après la [documentation OVHcloud sur les spécificités techniques](https://docs.ovhcloud.com/fr/guides/web-cloud/web-hosting/hosting-technical-specificities) :

- PHP avec PHP-FPM par défaut (hors anciennes offres) : `max_execution_time` 165 s et `memory_limit` 512 Mo ; le `php.ini` ne se modifie pas ; la version de PHP se choisit dans l'espace client.
- Envoi par `mail()` : quotas glissants sur 3600 s : 10 (gratuit), 20 (Starter), **100 (Perso, Startup)**, **200 (Pro)**, 2000 (Performance et au-dessus). Les envois en trop sont mis en file, pas perdus. L'envoi par SMTP n'est pas soumis à ce quota.
- Bases MySQL : 30 connexions simultanées par base ; connexion depuis un serveur extérieur refusée.
- Sauvegardes quotidiennes des bases (30 jours) et des fichiers (J-1 à J-14), **sans engagement contractuel** : il faut faire ses propres sauvegardes.
- En SSH, le trafic sortant est bloqué ; la documentation renvoie vers des scripts PHP.

### Ce que les forums rapportent (à vérifier par un essai)

- Il y a un **filtrage des connexions sortantes** du mutualisé, non documenté ; l'adresse de sortie est partagée et certains services la bloquent. Conséquence pour nous : les appels du PHP vers `accounts.google.com`, `github.com`, etc. (échange de code OAuth, vérification de jeton) peuvent échouer. Il faut les essayer depuis une page web et depuis un cron, pas depuis SSH.
- **Node.js n'est pas disponible** sur le mutualisé Perso et Pro (il l'est sur l'offre « Cloud Web » selon les forums) : l'API sera en PHP.

### Ce qui n'a pas pu être confirmé et se vérifie en phase 0

- Les directives `.htaccess` (`Header set`) permettant d'envoyer la politique de contenu (CSP) et `Cross-Origin-Opener-Policy: same-origin`, ainsi que `AddType application/wasm`. Elles sont nécessaires à l'application web (comme pour `web/scripts/serve.mjs`).
- La version de PHP offerte et la présence d'Argon2 (sinon bcrypt pour les mots de passe).
- Si le plan choisi donne un accès SSH, les tâches cron, l'espace disque, la possibilité d'écrire hors du dossier public.
- Le HTTPS : il est indispensable (les carnets chiffrés demandent un contexte sécurisé) ; il est fourni avec l'hébergement.

### Disposition proposée

- `/` : les fichiers de `web/dist` tels quels (comme aujourd'hui).
- `/api/` : un contrôleur frontal PHP (`index.php` + `.htaccess` de réécriture), sans framework lourd.
- Les secrets (identifiants MySQL, clés OAuth, clé de signature) dans un fichier **hors du dossier public** si l'hébergement le permet.
- MySQL pour les comptes, les sessions et les données ; un cron pour nettoyer les codes expirés.
- Sauvegarde nocturne à soi (export de la base vers un autre endroit), puisque celle d'OVH n'est pas contractuelle.

**Si l'essai de la phase 0 échoue** (en-têtes impossibles, appels sortants bloqués), la sortie est un VPS OVH d'entrée de gamme (quelques euros par mois), où l'on pourrait même réutiliser Node : le reste de cette étude ne change pas.

---

## 4. Architecture proposée

```
 Navigateur (SPA)            Programme desktop / Android
 ┌──────────────────┐        ┌───────────────────────────┐
 │ Éditeur + stockage│        │ Même éditeur ; dossiers    │
 │ local (IndexedDB, │        │ Zim (desktop) ou stockage  │
 │ coffre chiffré)   │        │ local ; jeton dans le       │
 │                  │        │ trousseau du système        │
 │  SyncEngine (cœur Rust → wasm : calcule quoi envoyer,    │
 │  quoi récupérer, quels conflits)                          │
 │  Sealer (cœur : chiffre/déchiffre chaque fichier)         │
 │  Connecteurs TS : une interface RemoteStorage             │
 └──────┬─────────┬──────────┬──────────┬────────────┬──────┘
        │         │          │          │            │
   SaaS Turtlzim  Dropbox  Google Drive  GitHub/GitLab  Nextcloud
   (PHP + MySQL,  (PKCE)   (jeton GIS)   (API commits)  (WebDAV)
   1 Mo/compte)
```

Principes :

1. **Le stockage local reste la copie de travail** (IndexedDB, dossier Zim, coffre). Le distant est un **réplica** : l'application fonctionne hors ligne, la synchronisation rattrape.
2. **Une interface `RemoteStorage` unique** : `list()` (chemin, révision/ETag, taille, date), `get(chemin)`, `put(chemin, octets, siRévision)`, `delete(chemin, siRévision)`. Chaque service est un petit adaptateur ; le SaaS en est un comme les autres.
3. **La logique de synchronisation vit dans le cœur** (nouvelle crate `zim-sync`, en Rust, testée nativement et compilée en wasm) : à partir de trois listes (local, distant, dernière synchronisation connue), elle calcule le plan (envoyer, récupérer, supprimer, conflit). Les adaptateurs ne font que de l'entrée-sortie. C'est la façon de respecter « la logique va dans le cœur » et de tester les cas de conflit avec des tests de propriété.
4. **Le chiffrement est une couche** (`Sealer`, cœur) entre le stockage local et l'adaptateur : le service distant ne voit que des blocs opaques.

### Synchronisation et sauvegarde automatique

- **Envoi** : après la sauvegarde locale d'une page (déjà temporisée), on envoie la page modifiée 2 à 5 s après la dernière frappe ; file d'attente persistante pour le hors-ligne.
- **Réception** : à l'ouverture, au retour de focus, puis toutes les 30 à 60 s tant que la page est visible (pas de WebSocket sur le mutualisé : interrogation simple avec ETag, donc peu coûteuse).
- **Conflits** : deux appareils ont modifié la même page. Première version : **on garde les deux** (la page distante devient « Page (conflit 2026-10-20 14:02) »), jamais de perte silencieuse. Une fusion à trois voies viendra plus tard si le besoin se confirme.
- **Connecteurs Git** : pas de commit à chaque frappe. Commits groupés (toutes les quelques minutes et à la fermeture), message lisible ; dépôt privé recommandé.
- **Quota de 1 Mo** : appliqué par le serveur (erreur 413 avec l'usage) et affiché par le client ; les pages sont compressées avant l'envoi. Les pièces jointes consomment vite : prévoir une règle claire (pages d'abord, pièces jointes tant qu'il reste de la place).

---

## 5. Comptes et authentification

### E-mail + mot de passe + code

- Inscription : adresse + mot de passe → code à 6 chiffres envoyé par e-mail (valable 10 min, 5 essais, stocké haché) → compte activé. Le « code de confirmation » peut aussi servir de second facteur à chaque nouvelle connexion (option).
- Mots de passe : Argon2id si PHP l'offre, sinon bcrypt (`password_hash`) ; politique de longueur minimale, pas de règles absurdes ; liste de mots de passe courants refusés.
- Réinitialisation du mot de passe par code e-mail. **Attention** : réinitialiser le mot de passe du compte ne permet **pas** de récupérer des notes chiffrées (voir §6).
- Protection contre les abus : une inscription ouverte qui envoie des e-mails est un outil de spam. Limites par IP et par adresse (table en base, pas de Redis), un test anti-robot (Cloudflare Turnstile, hCaptcha, ou à défaut un champ piège et une preuve de travail), et file d'envoi plafonnée. Avec 100 e-mails/h sur « Perso », il faudra passer par un service d'envoi transactionnel gratuit (par exemple un niveau gratuit de type Brevo) ou le SMTP d'OVH dès que les inscriptions augmentent : le code d'envoi sera derrière une interface `Mailer` pour changer sans réécrire.
- Sessions : jeton aléatoire opaque, **haché en base**, cookie `HttpOnly; Secure; SameSite=Lax` pour le web ; en-tête personnalisé contre le CSRF. Pour le natif, jeton « porteur » rangé dans le trousseau du système (pas dans `localStorage`).

### Connexion par un service gratuit

| Service | Protocole | Gratuit | Remarques |
|---|---|---|---|
| Google | OpenID Connect | Oui | Étendues `openid email profile` ; écran de consentement, page de confidentialité exigée |
| GitHub | OAuth 2 | Oui | L'échange du code **exige le secret client** (PKCE ajouté en 2025, mais le secret reste requis et le point d'échange n'accepte pas le navigateur, d'après [la discussion GitHub](https://github.com/orgs/community/discussions/15752)) : passage obligatoire par le serveur PHP |
| Microsoft | OpenID Connect | Oui | Comptes personnels et professionnels |
| GitLab | OpenID Connect / OAuth 2 | Oui | PKCE accepté pour une application web ; instance auto-hébergée possible |
| LinkedIn | OpenID Connect | Oui | Demande une page entreprise pour créer l'application |
| Facebook | OAuth 2 | Oui | Mode « en production » : vérification de l'application, URL de confidentialité et de suppression des données ; fragile, à faire en dernier |

Conception :

- Le **serveur PHP joue le courtier OAuth** (point de départ, rappel, échange du code avec `state`, `nonce` et PKCE). Il ne **conserve pas** les jetons du fournisseur : il sert à identifier la personne (adresse vérifiée + identifiant stable) puis ouvre une session Turtlzim.
- **Rattachement des comptes** : un compte social se rattache à un compte existant seulement si l'adresse est **vérifiée** par le fournisseur ; sinon deux comptes, pour éviter la prise de contrôle d'un compte par une adresse non vérifiée.
- **Risque propre à l'hébergement** : les appels du PHP vers les fournisseurs (filtrage de sortie OVH). Les jetons d'identité Google peuvent se vérifier **sans appel** (signature contre des clés publiques mises en cache) ; pour GitHub, l'échange du code oblige à un appel sortant. L'essai de la phase 0 tranche.
- **Un compte social n'a pas de mot de passe** : la passphrase de chiffrement (§6) est donc **distincte** du mot de passe et du compte, ce qui est aussi le bon choix pour les comptes par e-mail.

### Applications natives

- **Desktop (Tauri)** : ouvrir le navigateur du système sur la page de connexion, avec un retour sur une adresse locale (`127.0.0.1:port`) et PKCE ; le jeton va dans le trousseau du système.
- **Android (Capacitor)** : navigateur du système et retour par un schéma d'adresse propre à l'application (ou « App Links ») ; jeton dans le Keystore.
- Conséquences : la **politique de contenu** des coques doit autoriser l'adresse du SaaS et des connecteurs ; surtout, **la permission réseau d'Android doit être ajoutée** (elle est absente aujourd'hui, ce qui est une propriété forte du projet). Option : deux variantes de l'application, « hors ligne seulement » (sans permission réseau) et « avec comptes ».
- Le desktop avec dossiers Zim peut **synchroniser un dossier avec le SaaS** : le dossier est la copie locale, l'adaptateur distant fait le reste.

---

## 6. Chiffrement : clair ou chiffré, passphrase

### Principe (zéro connaissance)

- **Clair** : les pages partent telles quelles ; l'opérateur du SaaS, l'hébergeur ou le fournisseur du connecteur peut les lire. L'interface le dit clairement à l'activation.
- **Chiffré** : tout est chiffré **dans le client** avant l'envoi ; le serveur ne voit que des blocs opaques et ne peut ni les lire ni les comparer.

### Hiérarchie de clés proposée

1. La **passphrase** (demandée à la connexion, ou au déverrouillage) donne une clé de protection avec `crypto_pwhash` (Argon2id de libsodium) ou scrypt comme le coffre actuel, avec un sel enregistré dans le « trousseau » distant.
2. Une **clé maîtresse** aléatoire de 32 octets est stockée **enveloppée** par cette clé de protection (changer de passphrase = ré-envelopper, sans rechiffrer les notes).
3. Des **sous-clés** (`crypto_kdf`) pour le contenu, les noms de fichiers et l'index.
4. Chaque fichier est scellé avec XChaCha20-Poly1305 (nonce aléatoire, la donnée associée contient le nom distant et la version du format) ; **les noms sont masqués** (HMAC du chemin) et un index chiffré fait la correspondance.
5. **Clé de secours** (code à imprimer) affichée une seule fois : **sans elle, une passphrase perdue veut dire des notes perdues**, comme pour le coffre actuel. C'est inévitable si le serveur ne doit rien savoir, et l'interface doit le dire avant l'activation.
6. La clé n'existe qu'en mémoire (comme le coffre déverrouillé) et est effacée au verrouillage.

### Où le code vit

- Dans le **cœur Rust** (crate de chiffrement de fichiers), avec libsodium injecté comme aujourd'hui : même résultat en natif et en wasm, avec des **vecteurs de test communs** (c'est la règle du projet : une seule base de chiffrement).
- **Lien avec le coffre existant** : les carnets chiffrés locaux restent dans le coffre (stockés chiffrés au repos) ; la même passphrase dérive les clés des copies scellées envoyées au distant. Une seule passphrase pour tous les carnets chiffrés, comme aujourd'hui. Cela demande d'ajouter des commandes au cœur Turtl (liste `LOCAL_COMMANDS`) et de décider si l'envoi se fait dans le Worker du coffre.
- Alternative écartée : refaire la synchronisation propre à Turtl avec son serveur (protocole large, serveur Node + Postgres impossible sur le mutualisé).

### Ce que ça change dans les règles du projet

- « Un carnet chiffré ne va nulle part ailleurs que dans le coffre » devient « sort seulement **scellé** vers un service que la personne a choisi » ; les tests qui cherchent le texte clair dans tout ce que le navigateur garde restent valables, avec en plus une vérification : **aucune requête sortante ne contient de texte clair d'un carnet chiffré**.
- La politique de contenu (CSP) passe de `connect-src 'self'` à une liste d'origines précises (`api.dropboxapi.com`, `www.googleapis.com`, `api.github.com`, `gitlab.com`…), **par déploiement** et ajoutée seulement pour les connecteurs activés. Le service worker, lui, ne fait toujours aucune requête hors de son dossier.

---

## 7. Connecteurs

| Service | Authentification | Navigateur (CORS) | Détection des changements | Difficulté | Notes |
|---|---|---|---|---|---|
| **SaaS Turtlzim** | session du compte | même origine | ETag par fichier | Faible | 1 Mo, API PHP |
| **Dropbox** | OAuth 2 + PKCE, sans serveur | Oui | `list_folder` avec curseur (+ `longpoll`) | Moyenne | Dossier d'application ; `rev` pour les conflits |
| **Google Drive** | Google Identity Services, étendue `drive.file` | Oui | `changes.list` (jeton de page) | Moyenne à élevée | Étendue [classée non sensible](https://developers.google.com/workspace/drive/api/guides/api-specific-auth) (vérification de base seulement) ; l'application ne voit que les fichiers qu'elle crée ou qui lui sont ouverts (Picker) ; pas d'écriture atomique de plusieurs fichiers |
| **GitHub** | jeton personnel à portée limitée, ou OAuth par le serveur PHP | API : oui ; échange du code : non | SHA des arbres | Moyenne | API « Git Data » pour des commits multi-fichiers atomiques ; limite 5000 requêtes/h ; dépôt privé conseillé |
| **GitLab** | OAuth 2 + PKCE (gitlab.com ou instance propre) | Oui | commits | Moyenne | L'API de commit accepte plusieurs actions en un commit |
| **ownCloud / Nextcloud** | mot de passe d'application (WebDAV) | **Non** par défaut | ETag, `If-Match` | Moyenne | Fonctionne en natif (sans CORS) ; en web il faut que l'administrateur autorise l'origine de l'application |
| OneDrive, Box, pCloud, S3 compatible | à voir | variable | variable | — | Plus tard, sur demande ; WebDAV générique couvre déjà beaucoup de cas |

Règles communes : les jetons des connecteurs restent **dans le client** (mémoire, ou trousseau du système en natif) ; ils ne passent pas par le SaaS ; une révocation est facile côté fournisseur. Un carnet est lié à **un seul** endroit distant à la fois au début (simplicité), le multi-destination viendra après.

---

## 8. Sécurité, vie privée, droit

- **XSS = vol de session** : la politique de contenu stricte déjà en place (scripts propres seulement) reste la première défense ; cookies `HttpOnly` ; aucun jeton dans `localStorage` pour le web.
- **Injection, CSRF, limitation de débit, journaux sans contenu de notes** : à traiter dès le squelette PHP ; requêtes préparées partout ; en-têtes de sécurité identiques à `serve.mjs`.
- **RGPD** (hébergement OVH en Europe) : politique de confidentialité, conditions d'usage, **suppression du compte et des données** en un clic, **export** des données, durée de conservation des journaux courte, pas de traceurs (le cookie de session est strictement nécessaire, donc sans bandeau). Les pages de confidentialité et de suppression sont aussi exigées pour créer des applications Google, Facebook et LinkedIn.
- **Notes en clair sur le SaaS** : lisibles par l'opérateur ; à dire, et à proposer chiffré par défaut une fois la fonction prête.
- **Disponibilité** : l'application reste utilisable sans réseau ni compte ; une panne du SaaS n'empêche jamais d'écrire.
- **Sauvegardes** : dumps MySQL nocturnes vers un autre endroit (celles d'OVH ne sont pas contractuelles).

---

## 9. Feuille de route

Les durées sont des ordres de grandeur pour un développeur à temps plein ; elles supposent que les décisions du §10 sont prises. Chaque lot se termine par des critères d'acceptation vérifiables et des tests, comme pour les jalons déjà faits.

| Lot | Contenu | Durée | Fin du lot quand… |
|---|---|---|---|
| **0. Essai d'hébergement** | Déployer `web/dist` sur le plan OVH visé ; vérifier en-têtes (CSP, COOP), type `application/wasm`, HTTPS, PHP (version, Argon2), MySQL, cron, `mail()` et SMTP, **appels sortants du PHP** vers Google, GitHub, Dropbox ; l'application et le coffre chiffré fonctionnent depuis l'URL publique | 1 à 3 jours | un rapport « OK / pas OK » par point, et le plan d'hébergement est confirmé ou remplacé (VPS) |
| **1. API et comptes** | Squelette PHP (routes, PDO, migrations), inscription + code e-mail, connexion/déconnexion, sessions, réinitialisation, limites de débit, anti-robot, suppression et export du compte ; tests (PHP en ligne de commande + base de test) | 1,5 à 2 semaines | un compte se crée, se confirme, se connecte et se supprime ; les abus sont freinés (tests) |
| **2. Interface de compte (web)** | Dialogues de connexion et d'inscription, menu de compte, **mode sans compte inchangé**, indicateur d'usage du quota | 1 semaine | scénarios navigateur : avec et sans compte, aucune régression des 115 scénarios existants |
| **3. Synchronisation (en clair)** | Crate `zim-sync` (plan de synchronisation, conflits, tests de propriété) ; interface `RemoteStorage` ; adaptateur SaaS ; file hors ligne ; sauvegarde automatique ; quota 1 Mo (413) ; conflit = copie de conflit | 3 à 4 semaines | deux navigateurs sur un même compte convergent ; une coupure réseau ne perd rien ; le quota est respecté |
| **4. Chiffrement du cloud** | Hiérarchie de clés, scellage de fichier dans le cœur (vecteurs natif/wasm), noms masqués, passphrase à la connexion, clé de secours, changement de passphrase, lien avec le coffre ; modèle de menaces mis à jour | 2 à 3 semaines | le serveur ne voit aucun clair (test sur les requêtes) ; restauration sur un autre navigateur avec passphrase ; perte de passphrase sans clé de secours = perte, dite à l'utilisateur |
| **5. Connexion sociale** | Courtier OAuth/OIDC en PHP : Google et GitHub d'abord, puis Microsoft et GitLab ; LinkedIn ; Facebook en dernier ; rattachement par adresse vérifiée | 2 à 3 semaines | chaque fournisseur : connexion, rattachement, refus d'une adresse non vérifiée |
| **6. Connecteurs** | Dropbox, puis Google Drive, GitHub/GitLab (commits groupés), Nextcloud/WebDAV ; chacun avec détection de changements et tests contre un faux serveur | 3 à 5 semaines (3 à 5 jours chacun) | un carnet se lie, se synchronise et se délie sur chaque service |
| **7. Applications natives** | Connexion par navigateur système (desktop : adresse locale + PKCE ; Android : schéma d'adresse), jeton dans le trousseau, permission réseau Android, synchronisation d'un **dossier Zim** avec le SaaS | 2 semaines | un carnet de dossier se synchronise avec le SaaS depuis le desktop ; le test sur émulateur couvre la connexion |
| **8. Durcissement et ouverture** | Revue de sécurité, tests de charge légers, pages légales, sauvegardes, surveillance, bêta fermée | 1 à 2 semaines | liste de contrôle signée, bêta avec quelques utilisateurs |

**Jalon utile le plus court (lots 0 à 3)** : comptes par e-mail, carnets en clair synchronisés avec sauvegarde automatique, 1 Mo : environ 5 à 7 semaines. Le chiffrement (lot 4) vient tout de suite après, car des notes en clair chez un hébergeur sont le seul point qui doit être traité **avant** une ouverture au public.

Ordre alternatif si l'urgence est « sauvegarder dans mon Drive ou mon Dropbox » plutôt que le SaaS : lots 3 et 6 (Dropbox) d'abord, sans comptes ; l'interface `RemoteStorage` et le moteur de synchronisation sont communs.

---

## 10. Décisions à prendre avant de démarrer

1. **Hébergement** : quel plan OVH (Perso, Pro, Performance) et quel **nom de domaine** ? Un accès SSH et un SMTP sont-ils disponibles ? (Le lot 0 y répond, mais le choix du plan en dépend.)
2. **Fournisseurs de connexion pour la première version** : recommandation **Google + GitHub**, puis Microsoft et GitLab ; LinkedIn et Facebook plus tard ; Apple exclu (payant). OK ?
3. **Code par e-mail** : seulement à l'inscription, ou à chaque nouvelle connexion (second facteur) ?
4. **Chiffrement par défaut** : proposer « chiffré » par défaut, et accepter qu'**aucune récupération** ne soit possible sans la clé de secours ?
5. **Un carnet = une destination** (SaaS ou un connecteur) au début : acceptable ?
6. **Applications natives** : une seule application avec comptes (permission réseau ajoutée), ou deux variantes (hors ligne seulement / avec comptes) ?
7. **Aspects légaux** : qui est l'éditeur du service (nom pour la politique de confidentialité et les conditions) ? Où se trouve l'adresse de contact pour la suppression des données ?
8. **Limite de 1 Mo** : par utilisateur, tout compris (pages + pièces jointes, après chiffrement) ? Une limite de taille d'une pièce jointe isolée ?
9. **Gratuité** : le service reste-t-il gratuit avec 1 Mo, ou un palier payant est-il prévu (ce qui change l'anti-abus et le RGPD) ?

---

## 11. Risques principaux et réponses

| Risque | Gravité | Réponse |
|---|---|---|
| Appels sortants du PHP bloqués ou IP partagée bloquée par un fournisseur | Élevée pour la connexion sociale | Essai en lot 0 ; vérifier les jetons Google sans appel ; sinon VPS |
| En-têtes `.htaccess` (CSP, COOP) non pris en compte | Élevée (l'application en dépend) | Essai en lot 0 ; sinon VPS |
| E-mails non reçus (quota, réputation d'envoi) | Moyenne | SPF/DKIM, `Mailer` interchangeable, service d'envoi gratuit |
| Spam via l'inscription | Moyenne | Anti-robot, limites, file plafonnée |
| Perte de données par un conflit de synchronisation | Élevée | « Garder les deux », journal local, tests de propriété, jamais de suppression silencieuse |
| Passphrase oubliée | Élevée (côté utilisateur) | Clé de secours, avertissement avant l'activation |
| Évolution des règles des fournisseurs (Google, Facebook, GitHub) | Moyenne | Adaptateurs isolés, étendues minimales, tests contre faux serveurs |
| Quota de 1 Mo ressenti comme trop petit | Moyenne | Compression, indicateur d'usage, connecteurs pour le reste |
| Dérive de la sécurité de l'application épinglée (CSP élargie) | Moyenne | Origines ajoutées par déploiement et par connecteur, test qui liste les origines autorisées |

---

## 12. Sources

- [OVHcloud : spécificités techniques des hébergements web](https://docs.ovhcloud.com/fr/guides/web-cloud/web-hosting/hosting-technical-specificities) (PHP-FPM, quotas d'envoi, bases de données, sauvegardes, trafic sortant en SSH).
- [Forum OVHcloud : connexions sortantes (curl) depuis le mutualisé](https://community.ovhcloud.com/t/appel-https-en-curl-sur-ovh-impossible/6634), [autre fil](https://community.ovhcloud.com/t/acces-web-services-externes/14191) (filtrage non documenté).
- [Forum OVHcloud : Node.js et l'offre Pro](https://community.ovhcloud.com/t/compatibilite-offre-pro-et-node-js/11296).
- [GitHub : support de PKCE pour les applications OAuth](https://github.com/orgs/community/discussions/15752) (le secret reste requis, pas de CORS sur l'échange).
- [Google : choisir les étendues de l'API Drive](https://developers.google.com/workspace/drive/api/guides/api-specific-auth) (`drive.file`, non sensible).

*Points non confirmés par une source : détails d'OVH sur `.htaccess` et les en-têtes, la disponibilité d'Argon2, le SSH et le cron selon le plan, les règles actuelles de vérification de Facebook et de LinkedIn, le détail de PKCE chez GitLab et Microsoft. Le lot 0 et une relecture de la documentation des fournisseurs au moment de les implémenter les confirmeront.*
