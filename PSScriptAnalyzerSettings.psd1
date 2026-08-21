@{
    IncludeDefaultRules = $true
    Severity            = @('Error', 'Warning', 'Information')

    ExcludeRules        = @(
        'PSUseShouldProcessForStateChangingFunctions',
        'PSAvoidUsingWriteHost'
    )

    Rules               = @{
        PSPlaceOpenBrace           = @{
            Enable             = $true
            OnSameLine         = $true
            NewLineAfter       = $true
            IgnoreOneLineBlock = $true
        }
        PSPlaceCloseBrace          = @{
            Enable             = $true
            NewLineAfter       = $true
            IgnoreOneLineBlock = $true
            NoEmptyLineBefore  = $false
        }
        PSUseConsistentIndentation = @{
            Enable              = $true
            Kind                = 'space'
            IndentationSize     = 4
            PipelineIndentation = 'IncreaseIndentationForFirstPipeline'
        }
        PSUseConsistentWhitespace  = @{
            Enable          = $true
            CheckInnerBrace = $true
            CheckOpenBrace  = $true
            CheckOpenParen  = $true
            CheckOperator   = $true
            CheckPipe       = $true
            CheckSeparator  = $true
        }
        PSAlignAssignmentStatement = @{
            Enable         = $true
            CheckHashtable = $true
        }
        PSAvoidUsingCmdletAliases  = @{ Enable = $true }
        PSUseCorrectCasing         = @{ Enable = $true }
        PSUseCompatibleCmdlets     = @{
            Compatibility = @('core-7.4.0-linux', 'core-7.4.0-windows')
        }
    }
}
