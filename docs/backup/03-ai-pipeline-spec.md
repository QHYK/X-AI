## 1. Pipeline Overview
```
Sources
↓
Collection
↓
Raw Content
↓
Content Processing
↓
Classification
↓
Selection
↓
Event Detection
↓
Event Merge
↓
Ranking
↓
Summary Generation
↓
Translation
↓
Daily Brief
```
第一阶段：Cheap Understanding
Source Default Tags
提取轻量信息：成本低
第二阶段：Selection
第三阶段：Deep Processing
生成：summary｜translation｜ranking｜merge。这样成本和质量都会更好。

数据库：
```
Source
 ↓
Raw Article
 ↓
Content
 ↓
Event
 ↓
Brief
```
## 2. Content Ingestion Pipeline
## 3. Content Understanding Pipeline
Classification
判断：
- Category
- Topic
- Tags
- Content Type

Eg:
输入：Reuters article
输出：
```JSON
{
    category:"Finance & Economy",
    tags:[
        "Federal Reserve",
        "Monetary Policy"
    ],
    type:"News"
}
```

## 4. Selection Pipeline
## 5. Event Detection & Merge Pipeline
## 6. Ranking Pipeline
## 7. Generation Pipeline
## 8. Human Feedback Loop
## 9. AI Models & Prompt Management
这一部分 Technical Spec 可以更详细。
Pipeline Spec 只定义：需要哪些模型能力
例如：
分类模型
Summarization
Embedding
Ranking
Translation