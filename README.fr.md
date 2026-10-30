# Starta CodeView

**Un éditeur de code local, rapide, où des agents IA travaillent à ta place — avec tes propres clés API.**

[![CI](https://github.com/ouelleta997-create/starta-codeview/actions/workflows/ci.yml/badge.svg)](https://github.com/ouelleta997-create/starta-codeview/actions/workflows/ci.yml) [![Licence : MIT](https://img.shields.io/badge/licence-MIT-green.svg)](LICENSE)

![Starta CodeView — quatre chats d'agent en parallèle](docs/screenshot.png)

*English: [README.md](README.md)*

**Quatre chats d'agent côte à côte** (4 × 1 colonnes, chacun avec sa conversation et son modèle) dans une seule fenêtre épurée, inspirée de Zed et Cursor. L'éditeur de code et le terminal sont à un clic si tu en veux. Branche ta clé **Claude, OpenAI, Gemini, Grok, DeepSeek et 20 autres** — ou un **modèle local avec Ollama**, gratuit. Les agents lisent et modifient tes fichiers, exécutent des commandes dans ton terminal local, et créent ou modifient des workflows **n8n** directement depuis le chat.

- **Aucun compte, aucun nuage, aucune télémétrie.** Clés et conversations restent sur ta machine (`~/.starta-codeview`). Les seuls appels réseau vont au fournisseur IA choisi et à ton instance n8n.
- **26 fournisseurs, un collage de clé.** Claude, OpenAI, Gemini, Grok, DeepSeek, Mistral, Z.ai, Groq, Together, OpenRouter, Ollama… et toute adresse compatible OpenAI. Les modèles sont listés en direct. [Détails](#fournisseurs).
- **De vrais agents.** Outils : lister / lire / écrire / modifier des fichiers, recherche par regex, **exécution de commandes** (PowerShell sous Windows, bash ailleurs). Les modifications s'affichent en diff ; les commandes défilent dans le terminal.
- **Parler au lieu de taper.** Chaque chat a son bouton micro. La dictée tourne **en local** (Whisper derrière un petit serveur FastAPI) : aucun son ne quitte ta machine. Voir [Dictée vocale](#dictée-vocale).
- **S'absenter.** Aucune limite d'étapes, aucun « dis continue » : l'agent travaille jusqu'au bout (il ne s'arrête que s'il répète 10 fois de suite exactement la même action).
- **n8n intégré.** Liste, ouvre, édite et enregistre les workflows depuis la barre latérale — ou demande simplement : « Crée un workflow qui envoie les nouveaux paiements Stripe dans Slack ». L'agent lit aussi les exécutions en erreur pour déboguer.
- **Léger.** Environ 4 000 lignes de TypeScript, une seule dépendance serveur (`ws`), ni Electron ni module natif.

## Fournisseurs

26 intégrés, tous avec liste de modèles en direct. Colle une clé dans **Réglages → Fournisseurs** et c'est prêt.

| | |
|---|---|
| **Claude** (Anthropic) · **OpenAI** · **Google Gemini** · **xAI Grok** · **DeepSeek** | les cinq grands |
| **Z.ai (GLM)** · **Mistral** · **Moonshot (Kimi)** · **Alibaba Qwen** · **MiniMax** | avec les adresses Chine et forfaits « coding » |
| **OpenRouter** · **Groq** · **Together AI** · **Fireworks AI** · **Cerebras** · **SambaNova** · **NVIDIA NIM** · **Hugging Face** · **Cohere** · **Nebius** · **Hyperbolic** · **Novita AI** · **SiliconFlow** | modèles ouverts hébergés |
| **Ollama** · **LM Studio** | **modèles locaux, sans clé, rien ne quitte ta machine** |
| **Autre (compatible OpenAI)** | n'importe quelle adresse qui parle « chat completions » : vLLM, LiteLLM, llama.cpp, un proxy d'entreprise… |

Chaque chat a son propre modèle : un modèle économique à côté d'un modèle costaud. Un modèle absent de la liste ? Tape son nom dans le sélecteur et utilise-le quand même.

**Ce qui est vérifié, honnêtement :** les adaptateurs sont couverts par des tests de bout en bout contre un faux serveur (streaming, appels d'outils, serveurs locaux sans clé, formats de liste variés, appels d'outils parallèles de Gemini), et chaque adresse hébergée a été vérifiée contre la vraie API avec une fausse clé (bonne URL, bon chemin, refus d'authentification propre). Le comportement avec de vraies clés — surtout la qualité des appels d'outils — dépend du modèle et a été **peu testé**. Ouvre un ticket avec le message d'erreur si un modèle se comporte mal.

**Ajouter un fournisseur** (toute API compatible OpenAI) : une entrée dans `PROVIDERS` de [`server/providers.ts`](server/providers.ts) :

```ts
mything: { label: "Mon fournisseur", baseUrl: "https://api.mything.ai/v1", keyUrl: "https://mything.ai/keys", fallbackModels: ["mon-modele"] },
```

L'écran de réglages, le sélecteur de modèle, le coffre à clés et les tests le prennent en compte tout seuls. Voir [CONTRIBUTING.md](CONTRIBUTING.md).

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
- Adaptateurs de fournisseurs testés contre un faux serveur, adresses vérifiées en direct avec une fausse clé ; **peu testés avec de vraies clés**. Ouvre un ticket avec le message d'erreur si un modèle se comporte mal.
- Interface en français seulement pour l'instant (pas encore de couche de traduction).
- Développé et testé sous Windows 11 ; macOS et Linux peu testés.
- Pas de complétion en ligne, pas d'interface git, pas d'extensions : ce n'est volontairement pas VS Code.

Fait par [Starta Intelligence](https://www.startaintelligence.ca). Licence [MIT](LICENSE).
