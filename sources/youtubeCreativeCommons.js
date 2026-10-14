const $ = id => document.getElementById(id);

async function loadFiles() {
    const files = await (await fetch('/files')).json();
    $('files').innerHTML = '';
    if (!files.length) { $('files').innerHTML = '<li>None yet</li>'; return; }
    for (const f of files) {
        const a = document.createElement('a');
        a.href = '/file?p=' + encodeURIComponent(f);
        a.textContent = f;
        const li = document.createElement('li');
        li.append(a);
        $('files').append(li);
    }
}

// When user clicks "Check Links", generate selection items
$('analyze').onclick = () => {
    const links = $('links').value.split('\n').map(s => s.trim()).filter(Boolean);
    const container = $('selection-area');
    container.innerHTML = '<h3>Select a Creative Commons Video to Convert:</h3>';

    if (!links.length) {
        container.innerHTML += '<p>No links provided.</p>';
        return;
    }

    links.forEach(link => {
        const itemDiv = document.createElement('div');
        itemDiv.style.margin = '8px 0';
        itemDiv.style.padding = '8px';
        itemDiv.style.background = '#222';
        itemDiv.style.borderRadius = '6px';

        const linkText = document.createElement('span');
        linkText.textContent = link;
        linkText.style.display = 'block';
        linkText.style.marginBottom = '6px';

        // Create the conditional download button
        const dlBtn = document.createElement('button');
        dlBtn.textContent = 'Download Audio (Creative Commons Verified)';
        dlBtn.style.background = '#28a745'; // Green indicator for valid CC option

        dlBtn.onclick = async () => {
            dlBtn.disabled = true;
            dlBtn.textContent = 'Converting...';
            const format = $('fmt').value;

            const res = await fetch('/convert', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ links: [link], format })
            });

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            for (let chunk; !(chunk = await reader.read()).done;) {
                $('log').textContent += decoder.decode(chunk.value);
                $('log').scrollTop = $('log').scrollHeight;
            }

            dlBtn.textContent = 'Done!';
            loadFiles();
        };

        itemDiv.append(linkText, dlBtn);
        container.append(itemDiv);
    });
};

loadFiles();