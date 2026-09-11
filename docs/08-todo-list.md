
+ Digest Read more
这个价值也高，因为现在 full_content_text 已经正式存在了，正好可以开始发挥作用。逻辑可以保持简单：有全文就生成/展示更详细中文总结；没有全文就跳原文。
+ Email Collector
这是新的输入通道，会碰 parsing、newsletter 拆分、source mapping，复杂度明显更高。
+ Editorial Memory / 人工知识加权
这个最值得最后做，因为它会真正改变 Stage1/Stage3 决策行为，应该建立在我们已经有足够真实 review 数据之后，不然很容易把“临时偏好”写成长期规则。
+ content text > 2000 就展示read more；API对应的用content调llm也可以。