⚠️ Not saved yet: `{{slug}}` is a new node and `keywords` is empty.

Search matches only title, claim and keywords — the body is never searched. keywords is the one field that holds **how this will be asked next time**, so without it this node can only be found by the exact wording of its claim.

Call `memory_upsert` again with the same arguments plus `keywords`:

- Words the person would say **the next time this applies**, in the language they speak to you **and** in English — you will search in either, and a word only in one language is invisible to the other. Today's example is only one of them — cover at least two other situations.
- The words **you** would search with: the kind of task (設定変更 / 改设置 / changing a setting).
- Verb forms and variants (変えたい 直したい 見直したい / 改一下 调整 不对).
- Leave out names and numbers that belong only to this one case.
