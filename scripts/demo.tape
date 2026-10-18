# Records the README and gallery demo. Run scripts/record-demo.sh, which prepares a clean
# agent directory in ~/pi-deepseek-tools so only this extension and the builtin tools appear.
# Escape closes the slash-command menu, so Enter then submits a bare command instead of
# accepting the highlighted completion.

Output assets/demo.mp4

Set Shell zsh
Set FontFamily "JetBrainsMono Nerd Font"
Set FontSize 16
Set Width 1240
Set Height 700
Set Padding 14
Set Theme "Catppuccin Mocha"
Set TypingSpeed 40ms
Set Framerate 24

Hide
Type "root=$PWD; cd $HOME/pi-deepseek-tools; PI_CODING_AGENT_DIR=$PWD/.agent pi -e $root/index.ts --no-session -ns --model deepseek/deepseek-flash"
Enter
Show
Sleep 9s

Type "Use deepseek_search for DeepSeek V4 release, count 3, then stop."
Enter
Sleep 16s

Type "/deepseek-tools"
Escape
Enter
Sleep 3s

Type "/deepseek-tools"
Escape
Enter
Sleep 3s

Type "/quit"
Enter
Sleep 1s
