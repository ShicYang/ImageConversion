# ImageConversion

一个基于 Tauri 2、React 19 和 Rust 的桌面图片批量转换工具。

应用面向本地桌面场景，支持拖拽文件后立即开始转换，默认输出到原文件所在目录，并尽量避免覆盖已有文件。

![预览](./public/image/preview.png)

## 功能特性

- 支持批量选择或拖拽图片文件进行转换
- 支持输出为 `PNG`、`JPEG`、`WebP`、`BMP`、`GIF`、`TIFF`、`ICO`
- 支持缩放配置：
  - 不缩放
  - 等比适配
  - 精确尺寸
- 支持是否允许放大图片
- 支持 JPEG 质量调节
- 支持 ICO 输出尺寸选择：`16 / 32 / 48 / 64 / 128 / 256`
- 转换过程中显示批量进度、成功数和失败数
- 单文件转换失败不会中断整批任务
- 自动生成不重复的输出文件名，避免覆盖原图

## 支持的输入格式

当前支持导入以下图片格式：

- `png`
- `jpg`
- `jpeg`
- `webp`
- `bmp`
- `gif`
- `tif`
- `tiff`
- `ico`

## 转换行为说明

- 默认输出目录为源文件所在目录
- 如果目标文件名已存在，会自动追加类似 ` (2)` 的后缀
- 转换任务按顺序处理，优先保证稳定性
- 转换执行期间界面会锁定，避免重复操作
- 浏览器预览模式仅用于界面开发；文件拖拽和原生文件选择需要在 Tauri 桌面运行时中使用

## 已知限制

- GIF 动图输入导出时会转换为单帧图片
- WebP 当前走 `image` crate 的默认写出方式
- ICO 输出会按所选尺寸生成正方形图标

## 技术栈

### 前端

- React 19
- TypeScript
- Vite 7
- Tailwind CSS 4
- Radix UI
- Lucide React

### 桌面端

- Tauri 2
- Rust 2021
- `image` crate
- `uuid`
- `thiserror`

## 本地开发

### 环境要求

建议准备以下环境：

- Node.js
- pnpm
- Rust
- Tauri 2 桌面开发依赖

### 安装依赖

```bash
pnpm install
```

### 启动前端预览

```bash
pnpm dev
```

说明：该模式主要用于界面预览，无法完整使用原生文件拖拽和系统文件选择能力。

### 启动桌面应用开发模式

```bash
pnpm tauri dev
```

### 构建前端资源

```bash
pnpm build
```

### 构建桌面应用

```bash
pnpm tauri build
```

## 项目结构

```text
ImageConversion/
├─ src/                    # React 前端
│  ├─ App.tsx              # 主界面与交互逻辑
│  ├─ components/ui/       # UI 组件
│  ├─ types/               # 前端类型定义
│  └─ lib/                 # 前端工具函数
├─ src-tauri/              # Tauri + Rust 桌面端
│  ├─ src/
│  │  ├─ commands.rs       # Tauri 命令入口
│  │  ├─ dto.rs            # 前后端通信数据结构
│  │  ├─ errors.rs         # 错误定义
│  │  ├─ events.rs         # 进度事件定义
│  │  └─ conversion/       # 图片转换核心逻辑
│  ├─ capabilities/        # Tauri 能力配置
│  └─ icons/               # 应用图标资源
├─ package.json            # 前端脚本与依赖
└─ README.md
```

## 核心流程

1. 用户拖拽或选择一批图片
2. 前端收集当前转换设置并调用 Tauri 命令 `convert_batch`
3. Rust 侧逐个读取源图片并执行缩放、格式转换与写出
4. 桌面端通过事件持续上报进度
5. 前端展示进度、结果列表和失败信息

## 关键代码位置

- 前端主界面：[src/App.tsx](src/App.tsx)
- 前端类型定义：[src/types/conversion.ts](src/types/conversion.ts)
- Tauri 命令入口：[src-tauri/src/commands.rs](src-tauri/src/commands.rs)
- Tauri 应用启动：[src-tauri/src/lib.rs](src-tauri/src/lib.rs)
- 转换核心服务：[src-tauri/src/conversion/service.rs](src-tauri/src/conversion/service.rs)
- 输出命名规则：[src-tauri/src/conversion/naming.rs](src-tauri/src/conversion/naming.rs)

## 后续可扩展方向

- 自定义输出目录
- 保留或编辑图片元数据
- 批量重命名规则
- 多线程并发转换
- 转换历史与最近任务记录
- 更多格式编码参数控制
