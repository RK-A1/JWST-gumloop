# Screenshots and demo

| File | Shows | Source |
|---|---|---|
| `demo.gif` | 51s: the same question under both agents, then the boundary holding. | screen recording, trimmed |
| `grants.png` | Five grants. Two views, three usage, nothing on the base tables or the embargo table. | `sql/03_demo_queries.sql` §1 |
| `audit.png` | Every query, with who asked and which agent ran it. | §2 |
| `two-agents.png` | Six queries from the grounded agent, three from the concise one. | §3 |

## Rebuilding the GIF

A straight conversion of the 116s source lands near 40 MB. This trims to the
three beats, speeds the waiting, and freezes on each answer so the payoff line
is readable:

```bash
ffmpeg -y -i screen_recording.mov -filter_complex "
[0:v]trim=4:32,setpts=(PTS-STARTPTS)/2,tpad=stop_mode=clone:stop_duration=2[a];
[0:v]trim=33:57,setpts=(PTS-STARTPTS)/2,tpad=stop_mode=clone:stop_duration=2[b];
[0:v]trim=58:115,setpts=(PTS-STARTPTS)/3.5,tpad=stop_mode=clone:stop_duration=4.5[c];
[a][b][c]concat=n=3:v=1:a=0,fps=10,scale=760:-1:flags=lanczos[out]
" -map "[out]" -an trimmed.mp4

ffmpeg -y -i trimmed.mp4 -vf "palettegen=stats_mode=diff" palette.png
ffmpeg -y -i trimmed.mp4 -i palette.png \
  -lavfi "paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle" demo.gif
```

2.7 MB out. The two-pass palette matters — the default per-frame one smears UI
text at this size.

To adjust a hold without the source, extend the GIF directly with `dither=none`.
Do not round-trip through video: re-dithering already-quantised frames invents
per-frame noise and defeats delta compression. The same 51 seconds went from
2.7 MB to 10 MB that way.
