# Reads a value from ../Config/Local.xcconfig (gitignored): team and bundle id live only there.
def artipeek_xcconfig(key)
  file = File.expand_path("../Config/Local.xcconfig", __dir__)
  return nil unless File.exist?(file)
  value = nil
  File.readlines(file).each do |l|
    m = l.match(/^\s*#{Regexp.escape(key)}\s*=\s*(.*?)\s*$/)
    value = m[1] if m && !m[1].empty?
  end
  value
end
