const fs = require('fs');
const path = require('path');

function replaceInBundle(filePath) {
  const fullPath = path.resolve(__dirname, '..', filePath);
  if (!fs.existsSync(fullPath)) return;
  let code = fs.readFileSync(fullPath, 'utf8');
  const originalLen = code.length;

  // 1. In filter dropdown (with bg class)
  code = code.replace(
    'K(`option`,{value:`dub`,class:`bg-[#170A08] text-white`},`🎙️ និយាយខ្មែរ`,-1),K(`option`,{value:`sub`,class:`bg-[#170A08] text-white`},`💬 អក្សរខ្មែរ`,-1)',
    'K(`option`,{value:`dub`,class:`bg-[#170A08] text-white`},`🎙️ បញ្ចូលសំឡេងមនុស្ស`,-1),K(`option`,{value:`sub`,class:`bg-[#170A08] text-white`},`🤖 បញ្ចូលសំឡេង AI`,-1)'
  );

  // 2. In catalog filter dropdown
  code = code.replace(
    'K(`option`,{value:`dub`},`🎙️ និយាយខ្មែរ`,-1),K(`option`,{value:`sub`},`💬 អក្សរខ្មែរ`,-1)',
    'K(`option`,{value:`dub`},`🎙️ បញ្ចូលសំឡេងមនុស្ស`,-1),K(`option`,{value:`sub`},`🤖 បញ្ចូលសំឡេង AI`,-1)'
  );

  // 3. In movie table row badge
  code = code.replace(
    'R(e.language_type===`dub`?`🎙️ និយាយខ្មែរ`:`💬 អក្សរខ្មែរ`)',
    'R(e.language_type===`dub`?`🎙️ បញ្ចូលសំឡេងមនុស្ស`:`🤖 បញ្ចូលសំឡេង AI`)'
  );

  // 4. In form dropdown (Add/Edit Movie modal)
  code = code.replace(
    'K(`option`,{value:`dub`},`🎙️ និយាយខ្មែរ`,-1),K(`option`,{value:`sub`},`💬 អក្សរខ្មែរ`,-1)',
    'K(`option`,{value:`dub`},`🎙️ បញ្ចូលសំឡេងមនុស្ស`,-1),K(`option`,{value:`sub`},`🤖 បញ្ចូលសំឡេង AI`,-1)'
  );

  fs.writeFileSync(fullPath, code, 'utf8');
  console.log('Successfully updated', filePath, '(length:', originalLen, '->', code.length, ')');
}

replaceInBundle('public/build/assets/app-DkOyG5va.js');
replaceInBundle('downloaded_assets/app.js');
