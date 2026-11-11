# ADR-0001: Node-first 社交实体模型

Status: Accepted
Date: 2026-10-26

## Context

最初骨架以 AI 宠物为社交主体，提前创建 `pet` 模块并将三身份概念（User/Node/Pet）写入协议。新产品定义要求 P2P 社交在没有智能体的情况下也成立，并能供任意授权的外部 Agent 使用。

## Decision

以 Raminga Node 作为长期逻辑社交实体；Node ID、传输 Peer ID 与 Operator 身份分离。Profile 分公开视图与授权内部上下文。Resident Agent 只是未来可选的扩展，不进入核心依赖。DSH 是外部适配器而非核心运行前提。

## Consequences

需要将旧 `core` 重构为 `node`，删除空 `pet` 骨架，新增 Identity、Profile、Social 模块并更新文档与 CLI。节点授权、wire 格式、密码算法、多设备一致性仍需后续独立设计，当前不作虚假的安全承诺。
