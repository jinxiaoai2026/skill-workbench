# NOTICE · 第三方与来源说明

本项目原创工作台、连接器、界面、测试、文档与演示数据按MIT发布。没有把已安装的外部Skill目录、第三方Skill全文、个人数据库、生产配置或私有Git历史包含进本仓库。

## npm依赖

依赖由pnpm-lock.yaml锁定并从包注册表安装，保留各包原许可证。这里记录公开版本直接依赖/开发依赖的实际包元数据；完整传递依赖以锁文件和安装后的许可证为准。node_modules不随源码打包。构建产物使用React与Lucide时，仍应保留相应包中的许可声明。

| 包 | 锁定安装版本 | 许可证 |
|---|---|---|
| `@fastify/rate-limit` | 11.2.1 | MIT |
| `@fastify/secure-session` | 8.4.1 | MIT |
| `@fastify/static` | 10.1.7 | MIT |
| `cheerio` | 1.2.0 | MIT |
| `fastify` | 5.12.7 | MIT |
| `lucide-react` | 1.61.0 | ISC |
| `pg` | 8.23.1 | MIT |
| `react` | 19.3.1 | MIT |
| `react-dom` | 19.3.1 | MIT |
| `yaml` | 2.9.1 | ISC |
| `zod` | 4.6.7 | MIT |
| `@types/node` | 26.6.5 | MIT |
| `@types/pg` | 8.23.1 | MIT |
| `@types/react` | 19.3.0 | MIT |
| `@types/react-dom` | 19.3.0 | MIT |
| `@vitejs/plugin-react` | 6.1.2 | MIT |
| `prettier` | 3.9.10 | MIT |
| `tsx` | 4.23.15 | MIT |
| `typescript` | 7.0.2 | Apache-2.0 |
| `vite` | 8.3.5 | MIT |

## 数据、技能与参考

- GitHub Trending及仓库元数据来自GitHub；项目与商标属于相应权利人。本项目的热度积分和中文摘要不代表GitHub官方排名或背书。
- 通过本工作台安装的Skill由用户从其原仓库获取，遵循上游许可证。本仓库不把这些内容重新标为MIT。系统的官方skill-installer脚本仅作为可选本机依赖引用，没有复制其全文。
- 中文说明由用户配置的模型或本机引擎根据公开元信息生成；请核对原始项目，生成内容不保证准确。默认清单特殊用途摘要文件保持为空，避免夹带个人定制条目。
- `scripts/demo.ts` / `src/server/demo.ts`的技能、设备、调用和项目均为本项目原创虚构演示数据；截图是该隔离实例真实渲染，不能当作真实使用统计、当期榜单或业务成效。
- 方案调研参考了Skills Manager、GitHub Trending Archive与ccusage的公开思路，没有把其源码或完整技能指令复制进此导出。

如发现第三方来源或许可标注有误，请提交不含敏感信息的Issue说明。
