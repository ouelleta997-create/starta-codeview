# Starta CodeView

**Un éditeur de code local, rapide, où des agents IA travaillent à ta place — avec tes propres clés API.**

**Quatre chats d'agent côte à côte** (4 × 1 colonnes, chacun avec sa conversation et son modèle) dans une seule fenêtre épurée, inspirée de Zed et Cursor. L'éditeur de code et le terminal sont à un clic si tu en veux. Branche ta clé **Claude**, **Z.ai (GLM)**, **Mistral** ou **OpenRouter**. Les agents lisent et modifient tes fichiers, exécutent des commandes dans ton terminal local, et créent ou modifient des workflows **n8n** directement depuis le chat.

- **Aucun compte, aucun nuage, aucune télémétrie.** Clés et conversations restent sur ta machine (`~/.starta-codeview`). Les seuls appels réseau vont au fournisseur IA choisi et à ton instance n8n.
- **Quatre fournisseurs, point.** Claude, Z.ai (API standard et GLM Coding Plan), Mistral, OpenRouter. Les modèles sont listés en direct.
- **De vrais agents.** Outils : lister / lire / écrire / modifier des fichiers, recherche par regex, **exécution de commandes** (PowerShell sous Windows, bash ailleurs). Les modifications s'affichent en diff ; les commandes défilent dans le terminal.
- **Parler au lieu de taper.** Chaque chat a son bouton micro. La dictée tourne **en local** (Whisper derrière un petit serveur FastAPI) : aucun son ne quitte ta machine. Voir [Dictée vocale](#dictée-vocale).
- **S'absenter.** Aucune limite d'étapes, aucun « dis continue » : l'agent travaille jusqu'au bout (il ne s'arrête que s'il répète 10 fois de suite exactement la même action).
- **n8n intégré.** Liste, ouvre, édite et enregistre les workflows depuis la barre latérale — ou demande simplement : « Crée un workflow qui envoie les nouveaux paiements Stripe dans Slack ». L'agent lit aussi les exécutions en erreur pour déboguer.
- **Léger.** Environ 4 000 lignes de TypeScript, une seule dépendance serveur (`ws`), ni Electron ni module natif.

## Démarrage

Il faut **Node 22.18+** (24 recommandé) et Chrome, Edge ou Brave.

```bash
git clone https://github.com/ouelleta997-create/starta-codeview
cd starta-codeview
npm install
npm start
```

Une fenêtre s'ouvre. Ensuite : **⚙ Réglages → Fournisseurs** (colle une clé), **ouvre un dossier**, puis **Ctrl+1…4** (ou clique un chat) pour parler à l'agent — ou clique son micro et dis-le. Pour activer la dictée : `npm run voice:install` (ou double-clic sur `Installer-voix.bat`). Sous Windows : double-clic sur `Lancer-CodeView.bat`.

## Dictée vocale

Chaque chat a un bouton micro à côté d'*Envoyer*. Clique, parle : il s'arrête tout seul après ~2 s de silence (ou reclique). Le texte arrive dans la zone de saisie de ce chat ; avec **Envoi auto** (barre du haut) il part direct à l'agent — et si l'agent travaille déjà, il part dès qu'il a fini. Un seul micro à la fois.

```bash
npm run voice:install                       # venv Python + FastAPI + faster-whisper (modèle ≈ 480 Mo, une fois)
npm run voice:install -- --model medium     # un modèle plus gros, plus précis
```

Il faut Python 3.9+. Tout vit dans `~/.starta-codeview` (`voice-venv`, `voice-models` ; les supprimer désinstalle la voix). CodeView lance `voice/server.py` lui-même et lui parle sur un port `127.0.0.1` aléatoire avec un jeton propre à chaque lancement. Modèle, langue, envoi auto : **Réglages › Voix**. Le processeur suffit (`small` ≈ 2 s par phrase) ; une carte NVIDIA est utilisée automatiquement.

## Autonomie et sécurité

- **Autonome** (défaut) : lit, écrit et exécute seul dans le dossier ouvert. Demande avant : suppressions récursives, `git push --force`, `git reset --hard`, téléchargement redirigé vers un shell, `sudo`, registre, écriture **hors** du dossier, **activation ou suppression** d'un workflow n8n.
- **Prudent** : demande avant chaque écriture, commande et modification n8n.

Le serveur n'écoute que sur `127.0.0.1`, exige un jeton propre à l'installation et vérifie `Host`/`Origin` : une page web visitée ne peut pas piloter ton terminal. Lis [SECURITY.md](SECURITY.md).

## Limites connues (v0.1)

- Terminal **sans PTY** : une commande à la fois, pas de programmes interactifs (`vim`, REPL, mots de passe).
- Adaptateurs de fournisseurs testés contre un faux serveur ; **peu testés sur les vraies API**. Ouvre un ticket avec le message d'erreur si un modèle se comporte mal.
- Développé et testé sous Windows 11 ; macOS et Linux peu testés.
- Pas de complétion en ligne, pas d'interface git, pas d'extensions : ce n'est volontairement pas VS Code.

Fait par [Starta Intelligence](https://www.startaintelligence.ca). Licence [MIT](LICENSE).
