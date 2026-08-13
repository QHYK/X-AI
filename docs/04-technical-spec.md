# System Architecture — 整体架构和数据流。
# Tech Stack — Next.js / Postgres / ORM / LLM API / Scheduler 等最终选型。
# Data Model — Source、Raw Article、Processed Content、Event、Daily Brief 等真正数据库结构。
# Processing Workflow — RSS → Raw → AI Stage 1 → Event Merge → Ranking → Brief；这里描述代码如何调用我们已经定义好的 AI stages。
# LLM Integration — Prompt 文件怎么管理、Structured Output、Web Search、失败重试、模型选择。
# Jobs & Scheduling — 每日什么时候抓取、什么时候处理、任务失败怎么办。
# Project Structure & Engineering Rules — 目录、模块边界、环境变量、日志、测试以及 Codex 应遵守的基本规范。