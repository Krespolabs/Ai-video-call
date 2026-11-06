# three.ws MCP — Tool Annotation & Title Inventory

Generated from the live tool catalogs (`TOOL_CATALOG` / `buildTools()`) — the exact `tools/list` wire payloads.

✅ = true, — = false. destructive ✅ only on irreversible deletes/spends.

| Server | Tool | Title | readOnly | destructive | idempotent | openWorld | Price (x402) |
|---|---|---|:--:|:--:|:--:|:--:|---|
| /api/mcp (main) | `getting_started` | Getting Started (free) | ✅ | — | ✅ | — | free |
| /api/mcp (main) | `list_my_avatars` | List my avatars | ✅ | — | — | ✅ | free |
| /api/mcp (main) | `get_avatar` | Get avatar | ✅ | — | — | ✅ | free |
| /api/mcp (main) | `search_public_avatars` | Search public avatars | ✅ | — | — | ✅ | free |
| /api/mcp (main) | `render_avatar` | Render avatar | ✅ | — | — | ✅ | $0.005 |
| /api/mcp (main) | `render_avatar_image` | Render an avatar to an image | — | — | ✅ | ✅ | free |
| /api/mcp (main) | `delete_avatar` | Delete avatar | — | ✅ | — | ✅ | free |
| /api/mcp (main) | `get_embed_code` | Get embed code | ✅ | — | ✅ | ✅ | free |
| /api/mcp (main) | `validate_model` | Validate glTF/GLB model | ✅ | — | ✅ | ✅ | $0.01 |
| /api/mcp (main) | `inspect_model` | Inspect glTF/GLB model | ✅ | — | ✅ | ✅ | $0.01 |
| /api/mcp (main) | `optimize_model` | Suggest optimizations for a glTF/GLB model | ✅ | — | ✅ | ✅ | $0.05 |
| /api/mcp (main) | `list_animations` | List animation presets | ✅ | — | ✅ | — | free |
| /api/mcp (main) | `apply_animation` | Apply an animation preset to a rigged model | — | — | — | ✅ | $0.02 |
| /api/mcp (main) | `text_to_animation` | Generate an animation from a text prompt and retarget it onto a model | — | — | — | ✅ | free |
| /api/mcp (main) | `solana_agent_reputation` | Get Solana agent reputation | ✅ | — | — | ✅ | free |
| /api/mcp (main) | `solana_agent_attestations` | List Solana agent attestations | ✅ | — | — | ✅ | free |
| /api/mcp (main) | `solana_agent_passport` | Get Solana agent passport | ✅ | — | — | ✅ | free |
| /api/mcp (main) | `pumpfun_recent_claims` | Recent pump.fun claims | ✅ | — | — | ✅ | free |
| /api/mcp (main) | `pumpfun_token_intel` | Pump.fun token intel | ✅ | — | — | ✅ | free |
| /api/mcp (main) | `pumpfun_creator_intel` | Pump.fun creator intel | ✅ | — | — | ✅ | free |
| /api/mcp (main) | `pumpfun_recent_graduations` | Recent pump.fun graduations | ✅ | — | — | ✅ | free |
| /api/mcp (main) | `call_agent` | Call agent | — | — | — | ✅ | free |
| /api/mcp (main) | `register_agent` | Register an agent on-chain | — | — | — | ✅ | free |
| /api/mcp (main) | `identity_check` | Screen an agent identity for impersonation | ✅ | — | — | ✅ | free |
| /api/mcp (main) | `remember` | Remember | — | — | — | ✅ | free |
| /api/mcp (main) | `recall` | Recall | ✅ | — | — | ✅ | free |
| /api/mcp (main) | `forget` | Forget | — | ✅ | — | ✅ | free |
| /api/mcp (main) | `oracle_top_plays` | Oracle top conviction plays | ✅ | — | — | ✅ | free |
| /api/mcp (main) | `oracle_coin` | Oracle verdict for one coin | ✅ | — | — | ✅ | free |
| /api/mcp (main) | `oracle_arm_watch` | Arm agent Oracle watch | — | — | ✅ | — | free |
| /api/mcp (main) | `oracle_watch_status` | Oracle watch status + track record | ✅ | — | ✅ | — | free |
| /api/mcp (main) | `trader_leaderboard` | Top pump.fun traders | ✅ | — | — | ✅ | free |
| /api/mcp (main) | `trader_profile` | Full track record for one agent | ✅ | — | — | ✅ | free |
| /api/mcp (main) | `copy_subscribe` | Subscribe to copy a trader | — | — | ✅ | — | free |
| /api/mcp (main) | `copy_status` | My copy subscriptions | ✅ | — | ✅ | — | free |
| /api/mcp-3d (Studio) | `getting_started` | Getting Started (free) | ✅ | — | ✅ | — | free |
| /api/mcp-3d (Studio) | `text_to_3d` | Generate a 3D model from a text prompt | — | — | — | ✅ | $0.15 |
| /api/mcp-3d (Studio) | `image_to_3d` | Reconstruct a 3D model from one or more images | — | — | — | ✅ | $0.15 |
| /api/mcp-3d (Studio) | `generation_status` | Check a 3D generation job | ✅ | — | — | ✅ | free |
| /api/mcp-3d (Studio) | `preview_3d` | Preview any GLB as an interactive 3D artifact | ✅ | — | ✅ | ✅ | free |
| /api/mcp-3d (Studio) | `remove_background` | Remove the background from an image | — | — | — | ✅ | $0.01 |
| /api/mcp-3d (Studio) | `remesh_model` | Remesh, simplify, repair, or convert a 3D model | — | — | — | ✅ | $0.02 |
| /api/mcp-3d (Studio) | `stylize_model` | Apply a one-click geometric stylization filter to a 3D model | — | — | — | ✅ | $0.02 |
| /api/mcp-3d (Studio) | `segment_model` | Split a 3D model into named, separable parts | — | — | — | ✅ | $0.02 |
| /api/mcp-3d (Studio) | `retexture_model` | Paint a new texture onto a 3D model from a text prompt | — | — | — | ✅ | $0.05 |
| /api/mcp-3d (Studio) | `retexture_region` | Repaint one masked region of a model's texture (magic brush) | — | — | — | ✅ | $0.05 |
| /api/mcp-3d (Studio) | `auto_rig_model` | Auto-rig a static 3D model (skeleton + skin weights) | — | — | — | ✅ | $0.05 |
| /api/mcp-3d (Studio) | `pose_model` | Resolve a text prompt to a pose-studio seed + joint rotations | ✅ | — | ✅ | — | $0.01 |
| /api/mcp-3d (Studio) | `direct_prompt` | Optimize a rough idea into a 3D-generation prompt (IBM Granite) | — | — | — | ✅ | $0.01 |
| /api/mcp-3d (Studio) | `generate_material` | Generate a glTF PBR material from a description (IBM Granite) | — | — | — | ✅ | $0.01 |
| /api/mcp-3d (Studio) | `save_avatar` | Save a generated GLB as a durable, named avatar | — | — | — | ✅ | free |
| /api/mcp-3d (Studio) | `inspect_model` | Inspect glTF/GLB model | ✅ | — | ✅ | ✅ | free |
| /api/mcp-3d (Studio) | `optimize_model` | Suggest optimizations for a glTF/GLB model | ✅ | — | ✅ | ✅ | free |
| /api/mcp-3d (Studio) | `list_animations` | List animation presets | ✅ | — | ✅ | — | free |
| /api/mcp-3d (Studio) | `apply_animation` | Apply an animation preset to a rigged model | — | — | — | ✅ | $0.01 |
| /api/mcp-3d (Studio) | `text_to_animation` | Generate an animation from a text prompt and retarget it onto a model | — | — | — | ✅ | free |
| /api/agent-mcp (Agent) | `getting_started` | Getting Started (free) | ✅ | — | ✅ | — | free / connection |
| /api/agent-mcp (Agent) | `wallet_status` | Check the agent's wallet | ✅ | — | — | ✅ | free / connection |
| /api/agent-mcp (Agent) | `find_services` | Find paid services the agent can call | ✅ | — | — | ✅ | free / connection |
| /api/agent-mcp (Agent) | `pay_and_call` | Pay an x402 service and return its result | — | ✅ | — | ✅ | free / connection |
| /api/agent-mcp (Agent) | `provision_wallet` | Create the agent's wallet | — | — | — | ✅ | free / connection |
| /api/agent-mcp (Agent) | `monetize_endpoint` | Publish a paid endpoint to earn USDC | — | — | — | ✅ | free / connection |
| /api/ibm-mcp (IBM Granite) | `ibm_granite_getting_started` | Getting Started (free) | ✅ | — | ✅ | — | free |
| /api/ibm-mcp (IBM Granite) | `ibm_granite_chat` | IBM Granite Chat ($0.02) | ✅ | — | — | ✅ | $0.02 |
| /api/ibm-mcp (IBM Granite) | `ibm_granite_code` | IBM Granite Code ($0.025) | ✅ | — | — | ✅ | $0.025 |
| /api/ibm-mcp (IBM Granite) | `ibm_granite_embed` | IBM Granite Embed ($0.005) | ✅ | — | ✅ | ✅ | $0.005 |
| /api/ibm-mcp (IBM Granite) | `ibm_granite_analyze` | IBM Granite Analyze ($0.04) | ✅ | — | — | ✅ | $0.04 |
| /api/ibm-mcp (IBM Granite) | `ibm_granite_forecast` | IBM Granite Forecast ($0.05) | ✅ | — | — | ✅ | $0.05 |
| /api/bazaar-mcp (Bazaar) | `getting_started` | Getting Started (free) | ✅ | — | ✅ | — | free / connection |
| /api/bazaar-mcp (Bazaar) | `search_services` | Search the x402 bazaar | ✅ | — | — | ✅ | free / connection |
| /api/bazaar-mcp (Bazaar) | `browse_services` | Browse the x402 bazaar | ✅ | — | — | ✅ | free / connection |
| /api/bazaar-mcp (Bazaar) | `get_service` | Get full details for one x402 service | ✅ | — | — | ✅ | free / connection |
| @three-ws/mcp-server (stdio) | `text_to_avatar` | Text → 3D avatar ($0.15) | — | — | — | ✅ | $0.15 |
| @three-ws/mcp-server (stdio) | `mesh_forge` | Text → 3D mesh ($0.25) | — | — | — | ✅ | $0.25 |
| @three-ws/mcp-server (stdio) | `forge_free` | Free text → 3D (TRELLIS) | — | — | — | ✅ | free |
| @three-ws/mcp-server (stdio) | `rig_mesh` | Rig 3D mesh ($0.20) | — | — | — | ✅ | $0.20 |
| @three-ws/mcp-server (stdio) | `forge_avatar` | Text/Image → rigged avatar ($0.45) | — | — | — | ✅ | $0.45 |
| @three-ws/mcp-server (stdio) | `ens_sns_resolve` | ENS + SNS resolve ($0.0005) | ✅ | — | — | ✅ | $0.0005 |
| @three-ws/mcp-server (stdio) | `agent_delegate_action` | Agent delegate action ($0.01) | — | — | — | ✅ | $0.01 |
| @three-ws/mcp-server (stdio) | `sentiment_pulse` | Sentiment pulse ($0.003) | ✅ | — | — | ✅ | $0.003 |
| @three-ws/mcp-server (stdio) | `get_pose_seed` | Pose seed ($0.001) | ✅ | — | ✅ | — | $0.001 |
| @three-ws/mcp-server (stdio) | `pump_snapshot` | Pump.fun snapshot ($0.005) | ✅ | — | — | ✅ | $0.005 |
| @three-ws/mcp-server (stdio) | `agent_reputation` | Agent reputation ($0.01) | ✅ | — | — | ✅ | $0.01 |
| @three-ws/mcp-server (stdio) | `vanity_grinder` | Solana vanity grinder ($0.05) | ✅ | — | — | — | $0.05 |
| @three-ws/mcp-server (stdio) | `agenc_list_tasks` | AgenC list tasks ($0.001) | ✅ | — | — | ✅ | $0.001 |
| @three-ws/mcp-server (stdio) | `agenc_get_task` | AgenC get task ($0.001) | ✅ | — | — | ✅ | $0.001 |
| @three-ws/mcp-server (stdio) | `agenc_get_agent` | AgenC get agent ($0.001) | ✅ | — | — | ✅ | $0.001 |
| @three-ws/mcp-server (stdio) | `aixbt_intel` | aixbt intel ($0.01) | ✅ | — | — | ✅ | $0.01 |
| @three-ws/mcp-server (stdio) | `aixbt_projects` | aixbt projects ($0.01) | ✅ | — | — | ✅ | $0.01 |
| @three-ws/mcp-server (stdio) | `agent_hire_discover` | Agent hire — discover ($0.01) | ✅ | — | — | ✅ | $0.01 |
| @three-ws/mcp-server (stdio) | `agent_hire` | Agent hire (env-configured, default $0.05) | — | — | — | ✅ | $0.05 |
| /api/mcp-3d (Studio) | `create_agent_persona` | Mint a persistent, living agent persona from a rigged GLB | — | — | — | ✅ | free |
| /api/mcp-3d (Studio) | `get_agent_persona` | Reload a persisted persona by id (continuity across sessions) | ✅ | — | ✅ | — | free |
| /api/mcp-3d (Studio) | `persona_say` | Speak a reply through a persona — lip-sync + emotion + gesture | — | — | — | — | free |

**Total tools across all servers: 94**

## Per-server counts

- /api/mcp (main): 35
- /api/mcp-3d (Studio): 24
- /api/agent-mcp (Agent): 6
- /api/ibm-mcp (IBM Granite): 6
- /api/bazaar-mcp (Bazaar): 4
- @three-ws/mcp-server (stdio): 19

## Tools flagged destructive (destructiveHint: true)

- `delete_avatar` (/api/mcp (main))
- `forget` (/api/mcp (main))
- `pay_and_call` (/api/agent-mcp (Agent))
