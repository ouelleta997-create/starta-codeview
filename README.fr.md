# Starta CodeView

**Un éditeur de code local, rapide, où des agents IA travaillent à ta place — avec tes propres clés API.**

Éditeur + terminal + chat d'agent dans une seule fenêtre épurée, inspirée de Zed et Cursor. Branche ta clé **Claude**, **Z.ai (GLM)**, **Mistral** ou **OpenRouter**. Les agents lisent et modifient tes fichiers, exécutent des commandes dans ton terminal local, et créent ou modifient des workflows **n8n** directement depuis le chat.

- **Aucun compte, aucun nuage, aucune télémétrie.** Clés et conversations restent sur ta machine (`~/.starta-codeview`). Les seuls appels réseau vont au fournisseur IA choisi et à ton instance n8n.
- **Quatre fournisseurs, point.** Claude, Z.ai (API standard et GLM Coding Plan), Mistral, OpenRouter. Les modèles sont listés en direct.
- **De vrais agents.** Outils : lister / lire / écrire / modifier des fichiers, recherche par regex, **exécution de commandes** (PowerShell sous Windows, bash ailleurs). Les modifications s'affichent en diff ; les commandes défilent dans le terminal.
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

Une fenêtre s'ouvre. Ensuite : **⚙ Réglages → Fournisseurs** (colle une clé), **ouvre un dossier**, puis **Ctrl+L** pour parler à l'agent. Sous Windows : double-clic sur `Lancer-CodeView.bat`.

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
