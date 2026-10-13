<!-- 这里记录一些重要的逻辑和错误处理方式, 以及一些bug修正过程中发现的需要被人类记住的信息 -->
# Key information

#### stage 3 什么时候失败？
Ranking	| Invented ID | 重复 ID | 缺失 ID
Event	|  直接剔除    | 去重	 | 不补齐
Digest	|  直接剔除    | 去重	 | 按输入顺序追加到末尾
Long-form| 直接剔除    | 去重	 | 按输入顺序追加到末尾

