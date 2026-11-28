# 标准图清单（24×24，阶段 5 §2.6.11）

挑选条件：A→B 可达、**最窄处 ≥0.25**（没有单格通道）、**至少一个大水面（≥20 格）**。
刻意排除：单格/双格通道（900 0.16 / 906 0.13 / 908 0.09 / 925 0.08 / 928 0.08 / 917 0.07）、无大水面的图。

24×24 的实战结论**只在这 6 张图上出**；随机图只用来偶尔看有没有崩，不当基准。

```
######## seed 919 · open · A→B 22 步 · 最窄 0.25 · 水 20% ########
城A(18,17) 城B(7,6)
...hhh...hw..v.....f....
....f....hh~~.ff..ff...h
...ff....h~~~~fffff.f..h
........vh~~~~~..ffffhhh
........v~~~~~..ff...hhh
..ff.....w~~~~...f.df..h
.fffh.hhhh~~~~~....ffff.
ff.hPh.hhh~h~~~w~~wfff~v
.fhP^P~~.hh.~~~~~~~f.~~.
PhP^Ph~~f..~~~~~vw~~~wv.
PPPPhf~~.v~~~~.P...f~vhh
.Phhff~~.vw~~.vP..fffhPP
...fff~~..~~~v.P....hP^^
.......~~v..~..P...hP^PP
.wvv..~~~~~~ww.PP...hPhh
v~~~~~~~~ww.w........h..
wvw.wff.................
.....f...h..~...~.......
.........h..~~~~~~......
...fff.f.hhhf~~~.~......
....ffffhhhh~~~~w...ddd.
....fffff.vhhh~~~.f..d..
..hhhhff...~~~~~~ff.....
...hhhfff..v~~~~~ff.fff.
```

```
######## seed 917 · open · A→B 33 步 · 最窄 0.07 · 水 20% ########
城A(20,20) 城B(4,3)
f.........hfw...........
f.......h.h~~....fffh...
ff.....hhhh~~w....f.h...
f.........w~~v......hh..
..d........~~...Ph..h...
.dd~~.ww...~~.hP^Ph.....
hhd~~ff~~~.h~~fhPhff....
h..~~~~~~~hhff~vhffff...
hh.~~~~~~~hhf~ffffff....
...h~~~~~.vhh~w.fffff...
....w.~~..w.~~v.PP.ff...
.....fw~w..~~~PPP..ff...
.....ffff..~~~.vPwff....
.....f....w~w..~~~ffhh.h
...ffffff.v~v~~~~~~~~fhP
....f.ffffv~.~~~~~~~~~P^
ff.......ff~~~~~~~~~~fhP
f.......fff~w~~~~f..~~.h
f.h...~...~~.~~~~ff~~.ff
hhh...~~~~~~vw~~PP.~~.f.
hh....d~~~.~...~PP.h....
.h..ff.....v~..PPfhh....
....ff.....w~v.fffhhh...
............w.....h.....
```

```
######## seed 902 · river-h · A→B 10 步 · 最窄 0.56 · 水 20% ########
城A(21,16) 城B(21,6)
^^Ph...fff.......hh.....
^Ph...fffhhh.....h.f....
Ph.w...ffhhh.......ff...
h~~v..fff..h....fffff...
fw~~...ff..d....fP......
fww~~~~~........fPh.....
....~~~~.......fhhhh....
.f.vv~.~w~~....hPPhh....
fffffv.v~~PhhhhP^^PP.~~.
wvfff..w~~Phhh.hP^^^Ph~~
~~~~~~~~~~~~~~~~~~~~~~~~
~~~~~~~~~~~~~~~~~~~~~~~~
w.www.dwhff.~~~~~v^^^^~~
.....dd.ffh~~~~~~hPP^P~~
.fhhhh...hP^~~~~ffhhPhff
.ffh.h...hd^PP~Pf~fff...
..f......ddP^PP~~~~~~...
.........hP^Phh~~~~~~...
.ff.......hPhhPhw.~fff..
..f.......hhhP^Ph.~~~wwv
...hh......hhP^Ph.w~~^~h
....h...f.hh.hPhf.hP^~~h
.......ffffhh.hff.fhPhhh
.....dfffff..hhff.ffh.hh
```

```
######## seed 915 · highland · A→B 13 步 · 最窄 0.71 · 水 19% ########
城A(8,15) 城B(2,8)
v..f.......f......vvvvvv
...f....hhff......vvv~~v
..fffhhhhhhh........v~~v
..fhhhhhhhhhh....~~~~~vv
...hhhhhhhhhh....~~~~~~v
..hhhhhhhhhhhh...~~~~~~.
..hhhhhhhhhhhh...~~~~...
..hhhhhh..hhhhh.~~~~~~..
.h..hhhh..hhhhhh~~~~~~..
.h..hhh~~hhhhhhh~~~~~f..
.~~~hhhh~~hhhhh~~~~~~fff
.~~~~~~~~hPhhhhP~h~P~fff
.~~~PPP~~PPPPPPPPPPPPhff
..~~~~P~~PPPPPPPPPPPPPh.
....f~~~~PPPPPPPPPPPPPh.
....f~~...PPPPPPPPPPPPh.
..~~~~~~..PPPPPPPPPPPP..
..~~~~~~..PPPPPPPPPPPP..
.~~~~~~...hPPPPPPPPPPh..
vv~~~~~...hP^^^^^^^^^Ph.
vv~.~~~..hP^^^^^^^^^Ph..
v~~vv.ffffhPP^^^^PPPh...
vvvvvv.....hhPPPPhhhfff.
vvvvvv.......hhhh..fff.v
```

```
######## seed 918 · isles · A→B 11 步 · 最窄 0.45 · 水 41% ########
城A(6,1) 城B(17,1)
.ffs.sPPPPPhhhPPPP......
~sff.h..h......hh..sfsss
~~...h....~ss~s.h...ff~~
~s.hhhhhh.~~~sfhhhPhhfs~
~s.hhh....~~~~fffffhhfs~
~~~ss~~ss~~~~~~~s~~ss~~~
~~~~~~~~~~~~~~~~~~~~~~~~
~~~~~~~ss~~~~~~ss~~~~~~~
~~~~~~~sf~~~~~sfs~~~~~~~
s~~~~~sffff....ffs~~~~~s
.~~~~s.hhhf..hhhh.s~~~~.
...~~.hPPhf..f.P.h.~~...
...~~hP^PhffffhP.h.~~...
.~~~~shPhhf..fhhh.s~~~~.
s~~~~~sh.....fff.s~~~~~s
~~~~~~~s.~~~~~~..~~~~~~~
~~~~~~~ss~~~~~~ss~~~~~~~
~~~~~~~~~~~~~~~~~~~~~~~~
~~~ss~~ss~~~~~~ss~~ss~~~
~s.hhh....~~~~ffffhhh...
~s.shhhhh.~~~~fhhhPsh...
~~ff..Ph.f~ss~s.hPh.....
~sf...Phhff....hPPh.....
fff...PPPPP.hPPPPP......
```

```
######## seed 922 · marsh · A→B 9 步 · 最窄 0.88 · 水 12% ########
城A(17,7) 城B(8,7)
~~~~~sss~~~~~~sssss~~~~~
~~~~~sswwwwwwwwwwsss~~~~
w~~~sswwwwwwwwwwwwwws~sw
ws~swwwwwww.wwwwwwwwsssw
w~swwwwwww....wwwwwwwssw
ssssw.........f....wwssw
sssww..f.....ff..h.wwwww
swwww.ff...h..f....wwwws
wwww..ff....h.ww....wwww
wwww..ffww.hh.w.hh..wwww
~wwww.ffffff.......wwww~
~swww.....ff.......wwws~
~swww....ff.fff.f..wwws~
~wwww.f..fff..f.ff.wwww~
wwwwfffh...hh.wwh...wwww
wwwwffh.......w.....wwww
swwww.......h....f.wwwws
wwwww.h....hh...ff.wwssw
wssww.............wwwssw
wswwwwwwww....wwwwwwws~w
wwswwwwwww.wwwwwwwwws~sw
ws~swwwwwwwwwwwwwwss~~~w
~~~~ssswwwwwwwwwws~~~~~~
~~~~~sssss~~~~~ssss~~~~~
```

| seed | 用途 |
|---|---|
| 919 | 主基准·开阔 |
| 917 | 长距离 |
| 902 | 主基准·横河 |
| 915 | 高地+湖泊 |
| 918 | 海战 |
| 922 | 短距离快攻 |

## 跑批口径

```bash
# 主基准（开阔 919 + 横河 902），先/后手各一局
for s in 919 902; do
  node --experimental-strip-types scripts/v4-duel-replay.ts --seed $s --era 3 --size 24 --cap 120 --symmetry fair --v4-side A --out "replays/v4/标准${s}-先手.json"
  node --experimental-strip-types scripts/v4-duel-replay.ts --seed $s --era 3 --size 24 --cap 120 --symmetry fair --v4-side B --out "replays/v4/标准${s}-后手.json"
done
```

**旧的 24×24 读数（seed 900）全部作废**——那是有单格通道的怪图。
