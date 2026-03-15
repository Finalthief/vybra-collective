$repo = 'C:\Users\Iris Hart\.openclaw\workspace\vybra-collective'
$days = (Get-Date) - (git -C $repo log -1 --format=%ci).Date
if ($days.TotalDays -gt 7) {
  Write-Output " Vybra Collective stale ($([math]::Round($days.TotalDays,1)) days). Consider adding an insight or updating the site."
} else {
  Write-Output "OK"
}
