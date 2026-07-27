# Boutique Rolynk + Paiement Stripe — vue d'ensemble

Ce document explique comment tout le système (boutique dans le launcher +
paiement Stripe) s'articule, quels fichiers font quoi côté launcher, et le
contrat d'API réel avec le service de paiement.

> **État actuel (à jour)** : le service de paiement (`payment-server`) est
> développé et déployé **directement sur le serveur OVH**
> (`rolynk_serveur_v1/payment-server/`), par une session séparée — il ne vit
> **pas** dans ce repo. Ce dossier (`HeliosLauncher-master`) est la
> référence pour le **launcher uniquement**. Les migrations MySQL réelles
> sont déjà appliquées (base `rolynk_mc_v1`, table `joueurs` avec colonnes
> `cristaux`/`rcoin`, table `player_grants`, utilisateur MySQL dédié
> `rolynk_payment`). Le launcher est aligné sur le contrat d'API confirmé
> ci-dessous (section 3). **Le service est en ligne** à
> `https://shop.rolynk.fr` (confirmé accessible via `/health`) et
> `PAYMENT_API_BASE` pointe déjà dessus — reste à valider un achat complet
> en mode test Stripe (carte `4242 4242 4242 4242`) avant de passer en clés
> live.

---

## 1. Vue d'ensemble

Deux morceaux, volontairement dans deux endroits différents :

1. **Le launcher** (ce repo, `app/`) — l'application Electron distribuée aux
   joueurs. Contient la Boutique (cartes de packs, mentions légales, CGV,
   confidentialité, popup de consentement avant paiement). Ne contient
   **aucune clé secrète**.
2. **Le serveur de paiement** (`rolynk_serveur_v1/payment-server/`, sur
   l'OVH — pas dans ce repo) — le service Node.js qui parle à Stripe,
   possède les clés secrètes, et crédite les Cristaux/Rcoin dans
   `rolynk_mc_v1` **uniquement après confirmation réelle du paiement**.

Pourquoi séparé ? Parce que le launcher est envoyé en clair à chaque joueur
(le JS est lisible). Si une clé secrète Stripe était dedans, n'importe qui
pourrait se faire créditer des Cristaux gratuitement ou déclencher des
remboursements frauduleux. Le serveur de paiement, lui, ne tourne que sur
ton infra — personne d'autre n'y touche.

```
┌─────────────────────┐        HTTPS        ┌──────────────────────┐        HTTPS       ┌────────┐
│   Launcher (joueur)  │ ───────────────────▶│  payment-server       │───────────────────▶│ Stripe │
│   app/landing.js     │  POST /checkout/create  │  (OVH, hors repo)  │  crée la session   │        │
│                      │◀─────────────────────│                      │◀───────────────────│        │
└─────────────────────┘   { url de paiement } └──────────────────────┘                    └────────┘
                                                         ▲                                      │
                                                         │ POST /webhooks/stripe                │
                                                         │ (paiement confirmé, remboursement,    │
                                                         │  renouvellement d'abonnement...)      │
                                                         └────────────────────────────────────────┘
                                                         puis crédite cristaux/rcoin dans
                                                         rolynk_mc_v1.joueurs (MySQL)
```

---

## 2. Ce qui a été fait côté launcher

Tout dans `app/` :

| Fichier | Rôle |
|---|---|
| `app/landing.ejs` | Structure HTML de la Boutique, du panneau légal, du popup de consentement |
| `app/assets/js/scripts/landing.js` | Ouverture/fermeture de la boutique, appel au serveur de paiement, gestion des erreurs |
| `app/assets/css/launcher.css` | Tout le style (cartes, animations, mode compact petite fenêtre) |
| `app/assets/lang/fr_FR.toml` / `en_US.toml` | Tous les textes (noms de packs, avantages, CGV, mentions légales, messages d'erreur de paiement) |

Ce que le joueur voit :
- 4 packs (Pack Commencement, Pack Intermédiaire, Big Pack, Rolynk Prestige)
  avec leurs Cristaux/Rcoin, avantages, prix
- Liens **Mentions légales / CGV / Confidentialité** en bas de la boutique
- Avant de payer : un popup qui fait cocher explicitement "j'accepte les
  CGV" et "je renonce à mon droit de rétractation" (obligatoire légalement
  pour livrer un bien numérique immédiatement)
- En cas de souci réseau/serveur : un message d'erreur clair et localisé
  (voir contrat d'erreurs ci-dessous), jamais un crash silencieux

Le launcher **n'accorde jamais lui-même** de Cristaux. Il demande une
session de paiement au serveur, puis ouvre l'URL Stripe renvoyée dans le
navigateur et attend.

---

## 3. Contrat d'API réel (confirmé avec la session côté serveur)

### Créer une session de paiement

```
POST /checkout/create
Content-Type: application/json

{
  "itemId": "commencement" | "intermediaire" | "big" | "prestige",
  "uuid": "<uuid Minecraft du joueur>",
  "pseudo": "<pseudo, optionnel>"
}
```

**Succès** — `200`
```json
{ "url": "<url de la session Stripe Checkout>" }
```

**Erreurs**
| Code HTTP | `error` | Quand |
|---|---|---|
| 400 | `uuid_invalide` | UUID manquant ou mal formé |
| 400 | `item_inconnu` | `itemId` qui ne correspond à aucun pack |
| 502 | `stripe_indisponible` | Stripe injoignable/en erreur côté serveur |

Le launcher (`app/assets/js/scripts/landing.js`, section "Pre-checkout
consent") sait déjà traduire ces trois codes en message localisé (FR/EN) ;
tout code d'erreur inconnu tombe sur un message générique plutôt que
d'afficher un texte brut au joueur.

Les 4 `itemId`, leurs prix et les quantités de Cristaux/Rcoin sont définis
**uniquement** côté serveur, dans `payment-server/src/packs.js` (sur l'OVH)
— le launcher n'envoie jamais de prix, seulement l'identifiant du pack.

### Base URL

```js
// app/assets/js/scripts/landing.js
const PAYMENT_API_BASE = window.ROLYNK_PAYMENT_API_BASE || 'https://shop.rolynk.fr'
```

**Confirmé en ligne** — `https://shop.rolynk.fr/health` répond `{"ok":true}`.
Un build de test peut toujours surcharger la valeur via
`window.ROLYNK_PAYMENT_API_BASE` sans toucher au code (utile pour tester
contre une instance locale).

### Popup "Paiement confirmé" dans le launcher — ce qu'il manque côté serveur

Le launcher affiche maintenant une popup ("Paiement confirmé !" / "Paiement
annulé") quand le joueur revient du paiement — mais ça dépend d'un lien
profond (`rolynk://...`) que **la page de retour Stripe doit ouvrir** dans
le navigateur. Tout le côté launcher est fait (`index.js` gère le lien,
même si le joueur relance l'app depuis ce lien ; `landing.js` affiche la
popup). Il ne manque qu'**une seule chose côté `payment-server`** :

Sur la page de succès (`success_url` de la session Stripe, ce que le joueur
voit juste après avoir payé) et la page d'annulation (`cancel_url`),
ajouter un petit script qui redirige vers le lien profond. **Important** :
la page de succès doit inclure `item=<itemId>` dans le lien (le launcher
s'en sert pour afficher "Paiement confirmé — Pack Commencement !" au lieu
d'un message générique) — `success_url` doit donc être créé avec l'itemId
déjà dedans, par exemple
`success_url: '.../success?session_id={CHECKOUT_SESSION_ID}&item=' + itemId`
au moment de `checkout.sessions.create`.

```html
<!-- en bas de la page de succès -->
<script>
  const params = new URLSearchParams(location.search)
  window.location.href = 'rolynk://payment-success?session_id=' + params.get('session_id') + '&item=' + params.get('item')
</script>
```
```html
<!-- en bas de la page d'annulation -->
<script>
  window.location.href = 'rolynk://payment-cancel'
</script>
```

Le navigateur va demander une fois "Ouvrir Rolynk Launcher ?" (comportement
normal pour un lien `rolynk://`, comme n'importe quel `spotify://` ou
`discord://`) — c'est cette confirmation qui relance/notifie l'app et fait
apparaître la popup. Le message de la popup mentionne aussi qu'il faut
changer de serveur (lobby ↔ ville) si les Cristaux n'apparaissent pas tout
de suite en jeu.

Tant que ce petit script n'est pas ajouté sur ces deux
pages, le paiement fonctionne quand même (les Cristaux sont bien crédités
via le webhook), simplement le joueur ne voit pas de confirmation dans le
launcher lui-même et doit vérifier son solde en jeu.

---

## 4. Ce qu'il reste à faire côté serveur OVH

Cette partie est gérée par la session qui a déployé `payment-server/` — pour
mémoire, la checklist encore ouverte d'après son dernier retour :

1. ~~Exposer le service publiquement en HTTPS~~ — **fait**, en ligne à
   `https://shop.rolynk.fr`.
2. **Vraies clés Stripe** — le `.env` du service a encore des valeurs
   `REPLACE_ME`. Récupérer les clés de test sur
   https://dashboard.stripe.com/test/apikeys pour valider d'abord en
   sandbox, avant de passer en clés live.
3. **Webhook Stripe** — une fois l'URL publique disponible, créer
   l'endpoint dans le dashboard Stripe (`https://<domaine>/webhooks/stripe`)
   et l'abonner à `checkout.session.completed`, `invoice.paid`,
   `charge.refunded`, `charge.dispute.created`,
   `customer.subscription.updated`, `customer.subscription.deleted`.
4. **Process manager** — faire tourner le service avec pm2/systemd pour
   qu'il survive à un crash ou un reboot.
5. **Mentions légales / CGV** — compléter les placeholders (`[Nom de
   l'éditeur]`, `[SIRET]`, etc.) encore présents côté serveur si le contenu
   légal y est dupliqué ; côté launcher, ces textes sont déjà remplis dans
   `app/assets/lang/*.toml` (nom, email, mention hébergement) — il reste
   juste la mention TVA et les coordonnées du médiateur, volontairement
   laissées en placeholder tant que tu n'as pas ces infos.
6. **Prix définitifs** — les montants actuels (4,99€ / 9,99€ / 19,99€ /
   9,99€ par mois) sont ceux qu'on a validés ensemble dans ce launcher ;
   confirmer qu'ils correspondent bien à ce qui est dans
   `payment-server/src/packs.js` sur le serveur.
7. **Côté plugin Minecraft (Java)** — reste à écrire : lire `rcoin` sur
   `rolynk_mc_v1.joueurs`, et consommer la file `player_grants` (grade
   Prestige, choix du pet légendaire) en marquant chaque ligne traitée via
   sa colonne `consumed_at` pour ne jamais l'appliquer deux fois. Hors
   scope du service de paiement lui-même.

Une fois l'URL publique confirmée, il suffira de mettre à jour
`PAYMENT_API_BASE` dans `landing.js` (section 3 ci-dessus) pour que ce
launcher parle au vrai service.

---

## 5. Test de bout en bout (une fois l'URL publique disponible)

1. Ouvrir la boutique dans le launcher, cliquer "ACHETER" sur le Pack
   Commencement.
2. Sur la page Stripe (mode test), payer avec la carte `4242 4242 4242
   4242`, date future, CVC quelconque.
3. Vérifier que `rolynk_mc_v1.joueurs.cristaux` a bien augmenté de 500 pour
   le compte de test.
4. Déclencher un remboursement depuis le dashboard Stripe test, vérifier
   que le solde redescend.
5. Tester l'abonnement Rolynk Prestige de la même façon, en particulier le
   premier mois (2000 Cristaux) puis un renouvellement simulé (1500
   Cristaux) — voir la doc Stripe sur le test des abonnements pour avancer
   un cycle sans attendre un mois réel.

Seulement après validation complète en mode test → bascule sur les clés
Stripe "live" et un nouveau webhook en mode live.
