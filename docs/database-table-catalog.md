# Database Table Catalog

Last updated: 2026-02-16
Schema baseline: `backend/prisma/schema.prisma`



## Table descriptions

| Table | Purpose | Key relations | Notes |
|---|---|---|---|
| `users` | Core user account/profile record with role flags, wallet linkage, and notification preferences. | Referenced by channels, briefs, deals, notifications, reviews, and user Telegram sessions. | Principal identity table. |
| `user_telegram_sessions` | Encrypted MTProto authorization/session state for a user. | FK to `users`. | Supports rich Telegram analytics access flows. |
| `channels` | Registered Telegram channels listed in marketplace workflows. | FK to `users` (`ownerId`), optional FK to `channel_stats` (`currentStatsId`). | Parent for stats, formats, listings, and deals. |
| `channel_members` | Membership model for channel team roles (`OWNER`, `ADMIN`, `MANAGER`, `VIEWER`). | FK to `channels`, FK to `users`. | Present in schema even if not currently central in runtime flows. |
| `channel_stats` | Snapshot metrics for a channel (subs, views, growth, ER, source metadata). | FK to `channels`; parent of `channel_stats_graphs`; referenced by `channels.currentStatsId`. | Stores point-in-time analytics snapshots. |
| `channel_stats_graphs` | Time-series graph data attached to a stats snapshot. | FK to `channel_stats`. | Used for detailed graph visualization/history. |
| `channel_categories` | Channel taxonomy for marketplace filtering/search. | Self-parent FK (`parentId`), m:n with `channels` via `_ChannelToChannelCategory`. | Supports hierarchical categories. |
| `_ChannelToChannelCategory` | Prisma-managed implicit join table for channel-category many-to-many. | FK to `channels`, FK to `channel_categories`. | Framework-managed relation table. |
| `ad_formats` | Channel ad offerings by format type and pricing baseline. | FK to `channels`; referenced by `listings`, `listing_format_offers`, and `deals`. | Canonical format definitions per channel. |
| `listings` | Public listing records created by channel owners. | FK to `channels`, FK to `ad_formats`; parent of `listing_format_offers`; referenced by `deals`. | Marketplace supply-side offer layer. |
| `listing_format_offers` | Per-listing overrides for ad format options and price adjustments. | FK to `listings`, FK to `ad_formats`. | Enables multi-format listing pricing. |
| `briefs` | Advertiser campaign requests (targeting, budget, timing, creative preferences). | FK to `users` (`advertiserId`); parent for `brief_applications` and `brief_saved_channels`; referenced by `deals`. | Marketplace demand-side request layer. |
| `brief_saved_channels` | Advertiser shortlist of channels saved under a brief. | FK to `briefs`, `channels`, `users`. | Saved/discovery workflow table. |
| `brief_applications` | Publisher application submitted to a brief. | FK to `briefs`; optionally linked from `deals.applicationId`. | Bridge from brief discovery into deal creation. |
| `deals` | Core transactional agreement lifecycle between advertiser and publisher. | FKs to users, channel, ad format; optional links to listing/brief/application/escrow wallet. | Central domain table for negotiation, payment, posting, and completion. |
| `creatives` | Versioned creative payload linked to a deal. | FK to `deals`. | Handles creative draft/revision/approval state. |
| `deal_events` | Event trail of lifecycle transitions and actions on a deal. | FK to `deals`. | Immutable-like audit timeline for deal changes. |
| `deal_chat_bridges` | Mapping between deal and Telegram topic/thread identifiers per participant side. | FK to `deals`; optional FK to `users` for closing actor. | Powers deal chat relay/topic routing. |
| `deal_posting_plan_proposals` | Negotiated posting plan proposals and counters for a deal. | FK to `deals`. | Captures posting method/time agreement workflow. |
| `escrow_wallets` | Escrow wallet metadata and lifecycle status. | Referenced by `deals` and `transactions`. | Supports per-deal custody/payment infrastructure. |
| `transactions` | Payment/escrow transaction attempts and confirmation metadata. | Optional FK to `escrow_wallets`; indexed by `dealId`. | Transaction ledger for escrow operations. |
| `disputes` | Dispute records for unresolved or contested deals. | FK to `deals`. | Admin arbitration and resolution workflow. |
| `reviews` | Post-deal reputation and rating records between users. | FK to `deals`; author/target FKs to `users`. | Reputation layer. |
| `notifications` | Persisted outbound notification records. | FK to `users`. | Tracks notification payload and delivery status fields. |
| `system_config` | Key-value configuration entries for platform behavior. | No FK dependencies. | Used for runtime/admin-configurable settings. |
| `audit_logs` | Sensitive-operation audit log structure. | No FK dependencies. | System audit/trace table. |
| `_prisma_migrations` | Prisma migration metadata/history table. | Framework-internal. | Tracks applied migration scripts. |

## ERD

![Database ERD](./database-erd.svg)
